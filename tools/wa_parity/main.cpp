// Renders the Web Audio parity scenarios with the sk::wa blocks.
//
//   synthkit_wa_parity tests/webaudio/parity.json out/
//
// writes out/<case>.f32 (interleaved stereo float32) for each case.
// web/test/webaudio-parity.cjs renders the same cases with Chromium's nodes
// and compares.
#include <synthkit/json.h>
#include <synthkit/webaudio.h>

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

using sk::Json;

namespace {

// The same generator as the browser side: a 32-bit LCG, as floats in -1…1.
struct Lcg {
  uint32_t s;
  explicit Lcg(uint32_t seed) : s(seed) {}
  float next() {
    s = s * 1664525u + 1013904223u;
    return static_cast<float>(static_cast<double>(s) / 4294967296.0 * 2 - 1);
  }
};

void applyAuto(sk::wa::Param& p, const Json& list) {
  for (const Json& a : list.items()) {
    const std::string& op = a[0].string();
    bool ok = true;
    if (op == "setValueAtTime") ok = p.setValueAtTime(static_cast<float>(a[1].number()), a[2].number());
    else if (op == "linearRampToValueAtTime") ok = p.linearRampToValueAtTime(static_cast<float>(a[1].number()), a[2].number());
    else if (op == "exponentialRampToValueAtTime") ok = p.exponentialRampToValueAtTime(static_cast<float>(a[1].number()), a[2].number());
    else if (op == "setTargetAtTime") ok = p.setTargetAtTime(static_cast<float>(a[1].number()), a[2].number(), a[3].number());
    else if (op == "setValueCurveAtTime") {
      std::vector<float> c;
      for (const Json& v : a[1].items()) c.push_back(static_cast<float>(v.number()));
      ok = p.setValueCurveAtTime(c.data(), static_cast<int>(c.size()), a[2].number(), a[3].number());
    } else if (op == "cancelScheduledValues") p.cancelScheduledValues(a[1].number());
    else if (op == "cancelAndHoldAtTime") p.cancelAndHoldAtTime(a[1].number());
    else std::fprintf(stderr, "unknown automation %s\n", op.c_str());
    if (!ok) std::fprintf(stderr, "automation refused: %s\n", op.c_str());
  }
}

// Builds an impulse response the same way as the browser side.
std::vector<std::vector<float>> makeIr(const Json& j, double sr) {
  const int ch = static_cast<int>(j["channels"].number(2));
  const int len = static_cast<int>(std::floor(sr * j["seconds"].number(0.2)));
  const double decay = j["decay"].number(3);
  Lcg rng(static_cast<uint32_t>(j["seed"].number(1)));
  std::vector<std::vector<float>> ir(static_cast<std::size_t>(ch), std::vector<float>(static_cast<std::size_t>(len)));
  for (int c = 0; c < ch; ++c)
    for (int i = 0; i < len; ++i)
      ir[static_cast<std::size_t>(c)][static_cast<std::size_t>(i)] = static_cast<float>(rng.next() * std::pow(1 - static_cast<double>(i) / len, decay));
  return ir;
}

std::vector<float> softclipCurve(int n) {
  std::vector<float> c(static_cast<std::size_t>(n));
  for (int i = 0; i < n; ++i) {
    const double x = (i * 2.0) / (n - 1) - 1;
    c[static_cast<std::size_t>(i)] = static_cast<float>(std::tanh(2.5 * x) / std::tanh(2.5));
  }
  return c;
}

struct Node {
  virtual ~Node() = default;
  // One frame; `mono` says whether the signal is still one channel (l == r).
  virtual void process(double t, float& l, float& r, bool& mono) = 0;
};

struct Biquad : Node {
  sk::wa::BiquadFilter f[2];
  Biquad(const Json& j, double sr) {
    const std::string type = j["type"].string("lowpass");
    using T = sk::wa::BiquadFilter::Type;
    T t = type == "highpass" ? T::Highpass : type == "bandpass" ? T::Bandpass : type == "lowshelf" ? T::Lowshelf
        : type == "highshelf" ? T::Highshelf : type == "peaking" ? T::Peaking : type == "notch" ? T::Notch
        : type == "allpass" ? T::Allpass : T::Lowpass;
    for (auto& b : f) {
      b.prepare(sr);
      b.setType(t);
      b.set(static_cast<float>(j["frequency"].number(350)), static_cast<float>(j["Q"].number(1)),
            static_cast<float>(j["gain"].number(0)), static_cast<float>(j["detune"].number(0)));
    }
  }
  void process(double, float& l, float& r, bool& mono) override {
    l = f[0].process(l);
    r = mono ? l : f[1].process(r);
  }
};

struct Compressor : Node {
  sk::wa::DynamicsCompressor c;
  Compressor(const Json& j, double sr) {
    c.prepare(sr);
    c.set(static_cast<float>(j["threshold"].number(-24)), static_cast<float>(j["knee"].number(30)),
          static_cast<float>(j["ratio"].number(12)), static_cast<float>(j["attack"].number(0.003)),
          static_cast<float>(j["release"].number(0.25)));
  }
  void process(double, float& l, float& r, bool& mono) override {
    c.process(l, r);
    mono = false;
  }
};

struct Convolver : Node {
  sk::wa::Convolver c;
  Convolver(const Json& j, double sr) {
    auto ir = makeIr(j["ir"], sr);
    const float* chans[2] = {ir[0].data(), ir[ir.size() - 1].data()};
    c.setImpulse(chans, static_cast<int>(ir.size()), static_cast<int>(ir[0].size()), sr, j["normalize"].boolean(true));
    stereoIr = ir.size() == 2;
  }
  bool stereoIr = false;
  void process(double, float& l, float& r, bool& mono) override {
    if (mono) {
      c.processMono(l, l, r);
      mono = !stereoIr;
    } else {
      c.process(l, r);
    }
  }
};

struct Shaper : Node {
  sk::wa::WaveShaper s[2];
  Shaper(const Json& j, double) {
    auto curve = softclipCurve(static_cast<int>(j["curve"]["softclip"].number(1025)));
    const std::string os = j["oversample"].string("none");
    for (auto& w : s) {
      w.setCurve(curve.data(), static_cast<int>(curve.size()));
      w.setOversample(os == "2x" ? sk::wa::WaveShaper::Oversample::X2 : os == "4x" ? sk::wa::WaveShaper::Oversample::X4 : sk::wa::WaveShaper::Oversample::None);
    }
  }
  void process(double, float& l, float& r, bool& mono) override {
    l = s[0].process(l);
    r = mono ? l : s[1].process(r);
  }
};

struct Panner : Node {
  float pan;
  Panner(const Json& j, double) : pan(static_cast<float>(j["pan"].number(0))) {}
  void process(double, float& l, float& r, bool& mono) override {
    if (mono) sk::wa::StereoPanner::processMono(pan, l, l, r);
    else sk::wa::StereoPanner::process(pan, l, r);
    mono = false;
  }
};

struct Delay : Node {
  sk::wa::Delay d[2];
  sk::wa::Param time{0, 0, 1};
  Delay(const Json& j, double sr) {
    for (auto& x : d) x.prepare(sr, 1);
    time.setValue(static_cast<float>(j["time"].number(0)));
    applyAuto(time, j["timeAuto"]);
  }
  void process(double t, float& l, float& r, bool& mono) override {
    const double dt = time.valueAt(t);
    l = d[0].process(l, dt);
    r = mono ? l : d[1].process(r, dt);
  }
};

}  // namespace

int main(int argc, char** argv) {
  if (argc < 3) {
    std::fprintf(stderr, "usage: %s scenarios.json outdir\n", argv[0]);
    return 2;
  }
  std::ifstream in(argv[1]);
  std::stringstream ss;
  ss << in.rdbuf();
  Json doc;
  std::string err;
  if (!Json::tryParse(ss.str(), doc, &err)) {
    std::fprintf(stderr, "%s: %s\n", argv[1], err.c_str());
    return 1;
  }
  for (const Json& c : doc["cases"].items()) {
    const std::string name = c["name"].string();
    const double sr = c["sampleRate"].number(48000);
    const int frames = static_cast<int>(std::lround(sr * c["length"].number(0.5)));
    const Json& src = c["source"];
    const std::string type = src["type"].string();

    std::vector<std::unique_ptr<Node>> chain;
    for (const Json& n : c["chain"].items()) {
      const std::string kind = n["node"].string();
      if (kind == "biquad") chain.push_back(std::make_unique<Biquad>(n, sr));
      else if (kind == "compressor") chain.push_back(std::make_unique<Compressor>(n, sr));
      else if (kind == "convolver") chain.push_back(std::make_unique<Convolver>(n, sr));
      else if (kind == "shaper") chain.push_back(std::make_unique<Shaper>(n, sr));
      else if (kind == "panner") chain.push_back(std::make_unique<Panner>(n, sr));
      else if (kind == "delay") chain.push_back(std::make_unique<Delay>(n, sr));
      else { std::fprintf(stderr, "%s: unknown node %s\n", name.c_str(), kind.c_str()); return 1; }
    }

    // Sources.
    const double gainD = src["gain"].number(type == "noise" ? 0.5 : 1);
    const float gain = static_cast<float>(gainD);
    Lcg rngL(static_cast<uint32_t>(src["seed"].number(1))), rngR(static_cast<uint32_t>(src["seed"].number(1)) + 7777u);
    sk::wa::PeriodicWave wave;
    sk::wa::Oscillator osc;
    sk::wa::Param freq(440, -static_cast<float>(sr / 2), static_cast<float>(sr / 2)), detune(0), offset(0);
    if (type == "osc") {
      if (src.contains("basic")) {
        const std::string b = src["basic"].string();
        using B = sk::wa::PeriodicWave::Basic;
        wave.build(sr, b == "square" ? B::Square : b == "sawtooth" ? B::Sawtooth : b == "triangle" ? B::Triangle : B::Sine);
      } else {
        const Json& w = src["wave"];
        std::size_t n = std::max(w["real"].size(), w["imag"].size());
        std::vector<float> re(n, 0.f), im(n, 0.f);
        for (std::size_t i = 0; i < w["real"].size(); ++i) re[i] = static_cast<float>(w["real"][i].number());
        for (std::size_t i = 0; i < w["imag"].size(); ++i) im[i] = static_cast<float>(w["imag"][i].number());
        wave.build(sr, re.data(), im.data(), static_cast<int>(n), w["disableNormalization"].boolean(false));
      }
      osc.prepare(sr);
      osc.setWave(&wave);
      osc.reset();
      freq.setValue(static_cast<float>(src["frequency"].number(440)));
      applyAuto(freq, src["frequencyAuto"]);
      detune.setValue(static_cast<float>(src["detune"].number(0)));
      applyAuto(detune, src["detuneAuto"]);
    } else if (type == "constant") {
      offset.setValue(static_cast<float>(src["offset"].number(1)));
      applyAuto(offset, src["auto"]);
    }
    const bool stereoNoise = src["stereo"].boolean(false);
    const bool envelope = src["envelope"].boolean(false);

    std::vector<float> out(static_cast<std::size_t>(frames) * 2);
    for (int i = 0; i < frames; ++i) {
      const double t = i / sr;
      float l = 0, r = 0;
      bool mono = true;
      if (type == "noise") {
        // The envelope: loud bursts and quiet gaps, to exercise attack and release.
        // (Computed in double and rounded once, as the browser side's
        // Float32Array does.)
        const double env = envelope ? (std::fmod(t, 0.25) < 0.12 ? 1.0 : 0.08) : 1.0;
        l = static_cast<float>(static_cast<double>(rngL.next()) * gainD * env);
        if (stereoNoise) { r = static_cast<float>(static_cast<double>(rngR.next()) * gainD * env); mono = false; } else r = l;
      } else if (type == "impulse") {
        l = r = i == 0 ? 1.f : 0.f;
      } else if (type == "osc") {
        const float f = freq.valueAt(t), d = detune.valueAt(t);
        l = r = osc.next(f * std::exp2(d / 1200.f)) * gain;
      } else if (type == "constant") {
        l = r = offset.valueAt(t);
      }
      for (auto& n : chain) n->process(t, l, r, mono);
      out[static_cast<std::size_t>(i) * 2] = l;
      out[static_cast<std::size_t>(i) * 2 + 1] = r;
    }
    std::string path = std::string(argv[2]) + "/" + name + ".f32";
    std::FILE* f = std::fopen(path.c_str(), "wb");
    if (!f) { std::fprintf(stderr, "can't write %s\n", path.c_str()); return 1; }
    std::fwrite(out.data(), sizeof(float), out.size(), f);
    std::fclose(f);
  }
  return 0;
}
