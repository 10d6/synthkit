// synthkit Reed: a small foot-pumped reed organ, and the kit's example of
//   - a synth with its own page (ui/page.html, ui/page.js; API.md §9a),
//   - messages between page and engine (the treadles; API.md §9b),
//   - the Web Audio blocks (sk::wa; API.md §8a), as a browser sketch ported
//     to synthkit would use them.
//
// The treadles fill a reservoir and playing drains it. Pressure sets the
// loudness, tilts the reeds' harmonics and pulls their pitch slightly flat.
// With no wind there is no sound; a helper pump (on by default) keeps some
// wind coming, like reedorgan's default pumping, so keys always sound.
#include <synthkit/synth.h>

#include <cmath>

using namespace sk;

struct Reed;

struct ReedVoice : Voice {
  explicit ReedVoice(Reed& s) : synth(s) {}
  void prepare(const PrepareInfo& info) override;
  void start(const NoteOn& n, const StartInfo& s) override;
  void release() override { released = true; }
  void render(VoiceContext& ctx, Buffer& out) override;
  bool active() const override { return !released || level > 1e-4f; }

  Reed& synth;
  wa::Oscillator osc;
  wa::BiquadFilter tone;   // a high shelf at 1.5 × the reed's pitch: brightness and the wind's tilt
  float sr = 48000, t = 0, tau = 0.02f, level = 0;
  bool released = false;
};

struct Reed : Synth {
  Param bright, swell, room, helper, size;
  ModSource pressureSrc;
  MessageId treadleLeft, treadleRight, valve;

  void defineParams(ParamBuilder& b) override {
    bright = b.add("reed.bright").name("Brightness").range(0, 1).def(0.5).group("Voicing");
    swell = b.add("swell").name("Knee Swell").range(0, 1).def(0.3).group("Voicing").cc(11).cc(4);   // an expression or foot pedal
    room = b.add("room").name("Room").range(0, 1).def(0.25).group("Voicing");
    helper = b.add("wind.helper").name("Helper Pump").range(0, 0.3).def(0.12).group("Wind");
    size = b.add("wind.size").name("Reservoir").range(0.5, 4).def(1.5).unit("s").group("Wind");
  }
  void defineModSources(ModSourceBuilder& b) override {
    pressureSrc = b.add("wind.pressure").name("Wind Pressure");   // the page's gauge reads it
  }
  void defineMessages(MessageBuilder& b) override {
    treadleLeft = b.add("treadle.left");    // page → engine: [1] pressed, [0] let up
    treadleRight = b.add("treadle.right");
    valve = b.add("wind.valve");            // engine → page: [1] the relief valve opened, [0] closed
  }
  std::unique_ptr<Voice> makeVoice() override { return std::make_unique<ReedVoice>(*this); }

  // A reed's spectrum: strong low harmonics with a buzz above.
  wa::PeriodicWave wave;
  wa::BiquadFilter lid[2];
  wa::DynamicsCompressor comp;
  wa::Convolver roomIr;
  float sr = 48000;

  // The wind.
  float pressure = 0;          // 0…1 (the gauge shows × 3.6″)
  bool down[2] = {false, false};
  float travel[2] = {0, 0};    // how far each treadle has gone down, 0…1
  int lastFoot = -1;
  bool venting = false;

  void prepare(const PrepareInfo& info) override {
    sr = static_cast<float>(info.sampleRate);
    const float real[9] = {0, 0, 0.02f, 0.01f, 0, 0, 0, 0, 0};
    const float imag[9] = {0, 1, 0.62f, 0.38f, 0.24f, 0.15f, 0.1f, 0.06f, 0.04f};
    wave.build(info.sampleRate, real, imag, 9);
    for (auto& f : lid) { f.prepare(info.sampleRate); f.setType(wa::BiquadFilter::Type::Lowpass); }
    comp.prepare(info.sampleRate);
    comp.set(-16, 30, 4, 0.01f, 0.2f);
    // A small room: decaying stereo noise (seeded, so renders repeat).
    const int len = static_cast<int>(1.2 * info.sampleRate);
    std::vector<float> l(static_cast<std::size_t>(len)), r(static_cast<std::size_t>(len));
    dsp::Rng rng(11);
    for (int i = 0; i < len; ++i) {
      const float d = std::pow(1 - static_cast<float>(i) / len, 3.f);
      l[static_cast<std::size_t>(i)] = rng.bipolar() * d;
      r[static_cast<std::size_t>(i)] = rng.bipolar() * d;
    }
    const float* chans[2] = {l.data(), r.data()};
    roomIr.setImpulse(chans, 2, len, info.sampleRate);
  }

  void processEvents(EventContext& ctx) override {
    for (auto& m : ctx.messages()) {
      const int foot = m.is(treadleLeft) ? 0 : m.is(treadleRight) ? 1 : -1;
      if (foot < 0) continue;
      const bool press = m.value() > 0.5f;
      if (press && !down[foot]) {
        // Alternating feet keeps the bellows moving: a fresh stroke starts
        // from the top; repeating the same foot catches it part-way.
        if (foot == lastFoot) travel[foot] = std::max(travel[foot], 0.5f);
        lastFoot = foot;
      }
      down[foot] = press;
    }
    for (auto& e : ctx.in()) ctx.out(e);
  }

  void processGlobal(GlobalContext& ctx, Buffer& io) override {
    const float dt = static_cast<float>(io.frames) / sr;
    float inflow = ctx.get(helper);
    for (int f = 0; f < 2; ++f) {
      if (down[f]) {
        inflow += 1.4f * (1 - travel[f]);          // most air at the top of the stroke
        travel[f] = std::min(1.f, travel[f] + dt / 0.7f);
      } else {
        travel[f] = std::max(0.f, travel[f] - dt / 0.35f);
      }
    }
    const float sw = ctx.get(swell);
    const float drain = 0.02f * static_cast<float>(ctx.activeVoices()) * (0.7f + 0.3f * sw);
    pressure += (inflow - drain) * dt / ctx.get(size);
    const bool vent = pressure >= 1;
    pressure = std::clamp(pressure, 0.f, 1.f);
    if (vent != venting) { venting = vent; ctx.post(valve, {vent ? 1.f : 0.f}); }
    ctx.setSource(pressureSrc, pressure);

    // Loudness rises to about 2″ (0.55) and then levels off.
    const float wind = std::tanh(pressure / 0.4f);
    const float cutoff = 1500 * std::pow(8.f, sw);    // the lid opens with the swell
    const float wet = ctx.get(room) * 0.6f;
    for (auto& f : lid) f.set(cutoff, 0);
    for (int i = 0; i < io.frames; ++i) {
      float l = lid[0].process(io.left[i]) * wind, r = lid[1].process(io.right[i]) * wind;
      comp.process(l, r);
      float rl = l, rr = r;
      roomIr.process(rl, rr);
      io.left[i] = l + rl * wet;
      io.right[i] = r + rr * wet;
    }
    for (auto& f : lid) f.flush();
  }

  // Free reeds go slightly flat as the wind rises (cents).
  float windCents() const { return -10.f * (pressure - 0.55f); }
};

void ReedVoice::prepare(const PrepareInfo& info) {
  sr = static_cast<float>(info.sampleRate);
  osc.prepare(info.sampleRate);
  osc.setWave(&synth.wave);
  tone.prepare(info.sampleRate);
  tone.setType(wa::BiquadFilter::Type::Highshelf);
}

void ReedVoice::start(const NoteOn& n, const StartInfo& s) {
  released = false;
  t = 0;
  // Low reeds take longer to speak (about 60 ms at the bottom, 8 ms at the top).
  const float hz = dsp::mtof(n.note);
  tau = std::clamp(0.02f * std::sqrt(220.f / hz), 0.004f, 0.03f);
  if (!s.sounding) { osc.reset(rng().uniform()); tone.reset(); level = 0; }
}

void ReedVoice::render(VoiceContext& ctx, Buffer& out) {
  const float hz = ctx.pitchHz() * std::exp2(synth.windCents() / 1200.f);
  // Brightness, plus the wind tilting the upper harmonics (±6 dB).
  tone.set(1.5f * hz, 0.7f, (ctx.get(synth.bright) - 0.5f) * 14 + (synth.pressure - 0.55f) * 12);
  const float rel = std::exp(-1.f / (0.06f * sr));
  for (int i = 0; i < out.frames; ++i) {
    if (!released) {
      const float on = 1 - std::exp(-t / tau);
      level = on * on;   // S-shaped: the reed's swing grows
      t += 1 / sr;
    } else {
      level *= rel;
    }
    out.add(i, tone.process(osc.next(hz)) * level * 0.12f);
  }
  tone.flush();
}

SK_SYNTH(Reed)
