#include "synthkit/engine.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <cctype>
#include <cmath>
#include <cstring>
#include <stdexcept>

#include "synthkit/error.h"
#include <unordered_set>

#if defined(__SSE__) || defined(_M_X64) || defined(_M_IX86)
#include <xmmintrin.h>
#define SK_HAVE_SSE 1
#endif

namespace sk {

// ============================================================== helpers

namespace {

class ScopedNoDenormals {
 public:
  ScopedNoDenormals() {
#if defined(SK_HAVE_SSE)
    saved_ = _mm_getcsr();
    _mm_setcsr(saved_ | 0x8040);  // FTZ | DAZ
#elif defined(__aarch64__) && (defined(__GNUC__) || defined(__clang__))
    uint64_t fpcr;
    __asm__ __volatile__("mrs %0, fpcr" : "=r"(fpcr));
    saved_ = fpcr;
    fpcr |= (1ull << 24);  // FZ
    __asm__ __volatile__("msr fpcr, %0" : : "r"(fpcr));
#endif
  }
  ~ScopedNoDenormals() {
#if defined(SK_HAVE_SSE)
    _mm_setcsr(static_cast<unsigned>(saved_));
#elif defined(__aarch64__) && (defined(__GNUC__) || defined(__clang__))
    uint64_t v = saved_;
    __asm__ __volatile__("msr fpcr, %0" : : "r"(v));
#endif
  }

 private:
  [[maybe_unused]] uint64_t saved_ = 0;
};

bool validCode(const std::string& c) {
  if (c.size() != 4) return false;
  for (unsigned char ch : c) if (ch < 32 || ch > 126) return false;
  return true;
}

std::string capitalize(std::string s) {
  if (!s.empty()) s[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(s[0])));
  return s;
}

void atomicMax(std::atomic<float>& a, float v) {
  float cur = a.load(std::memory_order_relaxed);
  while (v > cur && !a.compare_exchange_weak(cur, v, std::memory_order_relaxed)) {}
}

}  // namespace

// ============================================================== Division

bool Division::parse(std::string_view text, Division& out) {
  std::string t;
  for (char c : text) if (c != ' ') t += static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  if (t.empty()) return false;
  auto bars = t.find("bar");
  if (bars != std::string::npos) {
    std::string n = t.substr(0, bars);
    double v = n.empty() ? 1.0 : std::atof(n.c_str());
    if (v <= 0) return false;
    out = Division(v, true);
    return true;
  }
  bool triplet = false, dotted = false;
  if (t.back() == 't') { triplet = true; t.pop_back(); }
  else if (t.back() == '.') { dotted = true; t.pop_back(); }
  auto slash = t.find('/');
  if (slash == std::string::npos) return false;
  double num = std::atof(t.substr(0, slash).c_str());
  double den = std::atof(t.substr(slash + 1).c_str());
  if (num <= 0 || den <= 0) return false;
  Division d(4.0 * num / den);
  if (triplet) d = d.triplet();
  if (dotted) d = d.dotted();
  out = d;
  return true;
}

std::string Division::name() const {
  if (bar) {
    double r = std::round(beats);
    std::string n = std::fabs(beats - r) < 1e-9 ? std::to_string(static_cast<long long>(r)) : std::to_string(beats);
    return n + (beats == 1 ? " bar" : " bars");
  }
  for (int den : {1, 2, 4, 8, 16, 32, 64}) {
    double plain = 4.0 / den;
    for (int num = 1; num <= 16; ++num) {
      double b = plain * num;
      std::string base = std::to_string(num) + "/" + std::to_string(den);
      if (std::fabs(beats - b) < 1e-9) return base;
      if (num == 1 && std::fabs(beats - b * 2.0 / 3.0) < 1e-9) return base + "T";
      if (num == 1 && std::fabs(beats - b * 1.5) < 1e-9) return base + ".";
    }
  }
  return std::to_string(beats) + " beats";
}

// ============================================================== SynthInfo

SynthInfo SynthInfo::fromJson(const Json& j) {
  SynthInfo s;
  s.id = j["id"].string();
  s.name = j["name"].string(s.id);
  s.vendor = j["vendor"].string("");
  s.version = j["version"].string("0.0.0");
  s.pluginCode = j["pluginCode"].string("");
  s.vendorCode = j["vendorCode"].string("");
  s.patchVersion = static_cast<int>(j["patchVersion"].number(1));
  if (s.id.empty()) fail("synth.json: \"id\" is required");
  for (char c : s.id)
    if (!(std::isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_'))
      fail("synth.json: \"id\" may only use letters, digits, - and _");
  if (!s.pluginCode.empty() && !validCode(s.pluginCode))
    fail("synth.json: \"pluginCode\" must be exactly 4 characters");
  if (!s.vendorCode.empty() && !validCode(s.vendorCode))
    fail("synth.json: \"vendorCode\" must be exactly 4 characters");

  const Json& f = j["features"];
  auto& o = s.features;
  o.voices = std::clamp(static_cast<int>(f["voices"].number(o.voices)), 1, 128);
  if (f["voiceModes"].isArray()) {
    o.voiceModes.clear();
    for (auto& m : f["voiceModes"].items()) {
      std::string v = m.string();
      if (v != "poly" && v != "mono" && v != "legato")
        fail("synth.json: unknown voice mode \"" + v + "\"");
      o.voiceModes.push_back(v);
    }
    if (o.voiceModes.empty()) o.voiceModes = {"poly"};
  }
  o.unison = f["unison"].boolean(o.unison);
  o.standardEnvelopes = std::clamp(static_cast<int>(f["standardEnvelopes"].number(o.standardEnvelopes)), 0, 8);
  o.ampEnv = f["ampEnv"].boolean(o.standardEnvelopes > 0) && o.standardEnvelopes > 0;
  o.standardLfos = std::clamp(static_cast<int>(f["standardLfos"].number(0)), 0, 8);
  o.modSlots = std::clamp(static_cast<int>(f["modSlots"].number(0)), 0, 64);
  o.shapes = std::clamp(static_cast<int>(f["shapes"].number(0)), 0, 32);
  o.eventQueue = std::clamp(static_cast<int>(f["eventQueue"].number(o.eventQueue)), 16, 8192);
  return s;
}

// ============================================================== Core

namespace detail {

struct Scheduled {
  Beats beat = 0;
  MidiEvent e;
  uint32_t tag = 0;
  uint64_t seq = 0;
  bool used = false;
};

struct Slot {
  std::unique_ptr<Voice> voice;
  VoicePool::State state = VoicePool::State::Free;
  int note = -1, channel = 0;
  float vel = 0;
  uint64_t age = 0, serial = 0;
  bool sustained = false, legato = false, mono = false;
  double basePitch = 60, glidePitch = 60, glideRate = 0;  // semitones, per sample
  int uniIndex = 0, uniCount = 1;
  std::vector<dsp::Adsr> envs;
  std::vector<std::array<float, kControlBlock>> envBuf;
  float fade = 1, fadeStep = 0;
  float level = 0;
  int quietSamples = 0;
  float polyAT = 0;
  dsp::Rng rng;
  Beats startBeat = 0;
};

enum Mode { Poly = 0, Mono = 1, Legato = 2 };

struct Core {
  std::unique_ptr<Synth> synth;
  SynthInfo info;
  AudioEpoch epoch;
  std::unique_ptr<ParamStore> store;
  std::vector<std::unique_ptr<CustomSlotBase>> customs;

  int pMaster = -1, pVoiceMode = -1, pGlide = -1, pBend = -1, pUnison = -1, pUniDetune = -1, pUniSpread = -1, pA4 = -1;
  struct EnvP { int a, d, s, r, vel; };
  std::vector<EnvP> envP;
  std::vector<Mode> modes;  // index of voiceMode param -> Mode

  double sr = 48000;
  int maxBlock = 512;
  bool prepared = false;

  std::vector<Slot> slots;
  std::vector<dsp::Smoother> smoothers;
  std::vector<float> values, prev, lastTarget;
  std::vector<char> smoothed;
  std::array<float, kControlBlock> scratchL{}, scratchR{};
  std::vector<float> mixL, mixR;

  float modwheel = 0, aftertouch = 0, bend = 0, bendTarget = 0;
  float ccs[128] = {};
  bool sustain = false;
  int held[128] = {};
  int heldCount = 0;
  int mode = Poly;
  uint64_t ageCounter = 0, serialCounter = 0, eventSerial = 0;

  Transport transport;
  Beats clock = 0;
  bool clockStarted = false;
  bool lastPlaying = false;

  std::vector<MidiEvent> inEv, outEv;
  int inCount = 0, outCount = 0;
  std::vector<Scheduled> queue;
  uint64_t seq = 0;
  int frames = 0;
  Beats blockStart = 0, blockEnd = 0;
  double spb = 24000;  // samples per beat

  std::atomic<int> reqAllOff{0}, reqPanic{0};
  std::atomic<float> statPeak{0}, statLimDb{0};
  std::atomic<int> statDropped{0}, statSteals{0}, statActive{0};

  dsp::Limiter limiter;
  PatchMeta meta;
  Json extra = Json::object();  // patch sections we don't own yet (mod, shapes)

  VoicePool pool;
  EventContext ectx;
  VoiceContext vctx;
  GlobalContext gctx;

  Core(std::unique_ptr<Synth> s, SynthInfo i) : synth(std::move(s)), info(std::move(i)) {
    pool.core_ = this;
    ectx.core_ = this;
    vctx.core_ = this;
    gctx.core_ = this;
    buildParams();
    CustomBuilder cb(&epoch);
    synth->defineCustom(cb);
    customs = cb.take();
    std::unordered_set<std::string> ids;
    for (auto& c : customs)
      if (!ids.insert(c->id()).second) fail("duplicate custom state id '" + c->id() + "'");

    int nSlots = info.features.voices * 2;  // spares give stolen voices room to fade
    slots.resize(static_cast<std::size_t>(nSlots));
    for (auto& sl : slots) {
      sl.voice = synth->makeVoice();
      if (!sl.voice) fail("makeVoice() returned null");
      sl.voice->rng_ = &sl.rng;
      sl.envs.resize(static_cast<std::size_t>(info.features.standardEnvelopes));
      sl.envBuf.resize(sl.envs.size());
    }
    queue.resize(static_cast<std::size_t>(info.features.eventQueue));
  }

  void buildParams() {
    ParamBuilder b;
    synth->defineParams(b);
    auto& f = info.features;
    pMaster = b.count(); b.addKit("master").name("Master").range(-60, 6).def(0).unit("dB").group("Master");
    if (f.voiceModes.size() > 1) {
      std::vector<std::string> names;
      for (auto& m : f.voiceModes) {
        names.push_back(capitalize(m));
        modes.push_back(m == "mono" ? Mono : m == "legato" ? Legato : Poly);
      }
      pVoiceMode = b.count(); b.addKit("voiceMode").name("Voice Mode").choices(names).group("Voices");
    } else {
      modes.push_back(f.voiceModes[0] == "mono" ? Mono : f.voiceModes[0] == "legato" ? Legato : Poly);
    }
    bool anyMono = false;
    for (Mode m : modes) anyMono |= m != Poly;
    if (anyMono) { pGlide = b.count(); b.addKit("glide").name("Glide").range(0, 5).exp(3).def(0).unit("s").group("Voices"); }
    pBend = b.count(); b.addKit("bendRange").name("Bend Range").range(0, 24).integer().def(2).unit("st").group("Voices");
    if (f.unison) {
      pUnison = b.count(); b.addKit("unison").name("Unison").range(1, 8).integer().def(1).group("Voices");
      pUniDetune = b.count(); b.addKit("unisonDetune").name("Unison Detune").range(0, 100).def(12).unit("ct").group("Voices");
      pUniSpread = b.count(); b.addKit("unisonSpread").name("Unison Spread").range(0, 1).def(0.5).group("Voices");
    }
    pA4 = b.count(); b.addKit("sk.a4").name("A4 Tuning").range(400, 480).def(440).unit("Hz").group("Tuning");
    for (int e = 1; e <= f.standardEnvelopes; ++e) {
      std::string p = "env" + std::to_string(e) + ".";
      std::string n = "Env " + std::to_string(e) + " ";
      std::string g = "Envelope " + std::to_string(e);
      bool amp = e == 1 && f.ampEnv;
      EnvP ep{};
      ep.a = b.count(); b.addKit(p + "attack").name(n + "Attack").range(0.0005, 10).log().def(amp ? 0.005 : 0.01).unit("s").group(g);
      ep.d = b.count(); b.addKit(p + "decay").name(n + "Decay").range(0.001, 20).log().def(amp ? 0.3 : 0.5).unit("s").group(g);
      ep.s = b.count(); b.addKit(p + "sustain").name(n + "Sustain").range(0, 1).def(amp ? 0.8 : 0.3).group(g);
      ep.r = b.count(); b.addKit(p + "release").name(n + "Release").range(0.002, 20).log().def(amp ? 0.25 : 0.4).unit("s").group(g);
      ep.vel = b.count(); b.addKit(p + "velocity").name(n + "Velocity").range(0, 1).def(amp ? 0.5 : 0).group(g);
      envP.push_back(ep);
    }
    store = std::make_unique<ParamStore>(b.finish());
  }

  // ------------------------------------------------------------ prepare

  void prepare(double rate, int block) {
    sr = rate > 0 ? rate : 48000;
    maxBlock = std::max(block, 1);
    PrepareInfo pi{sr, maxBlock};
    synth->prepare(pi);
    int n = store->size();
    smoothers.assign(static_cast<std::size_t>(n), {});
    values.assign(static_cast<std::size_t>(n), 0);
    prev.assign(static_cast<std::size_t>(n), 0);
    lastTarget.assign(static_cast<std::size_t>(n), 0);
    smoothed.assign(static_cast<std::size_t>(n), 0);
    for (int i = 0; i < n; ++i) {
      auto& sp = store->spec(i);
      float v = store->get(i);
      values[i] = prev[i] = lastTarget[i] = v;
      smoothed[i] = sp.smoothing() > 0;
      smoothers[i].prepare(static_cast<float>(sr), static_cast<float>(sp.smoothing()));
      smoothers[i].reset(static_cast<float>(sp.toNorm(v)));
    }
    mixL.assign(static_cast<std::size_t>(maxBlock), 0);
    mixR.assign(static_cast<std::size_t>(maxBlock), 0);
    inEv.assign(1024, {});
    outEv.assign(static_cast<std::size_t>(1024 + info.features.eventQueue), {});
    for (auto& sl : slots) {
      sl.voice->prepare(pi);
      for (auto& e : sl.envs) e.prepare(static_cast<float>(sr));
      resetSlot(sl);
    }
    limiter.prepare(static_cast<float>(sr));
    mode = currentMode();
    prepared = true;
    epoch.running = true;
  }

  void checkMode() {
    int m = currentMode();
    if (m != mode) { releaseAll(true); mode = m; }
  }

  int currentMode() const {
    if (pVoiceMode < 0) return modes[0];
    int i = static_cast<int>(std::lround(store->get(pVoiceMode)));
    return modes[static_cast<std::size_t>(std::clamp(i, 0, static_cast<int>(modes.size()) - 1))];
  }

  void resetSlot(Slot& s) {
    s.state = VoicePool::State::Free;
    s.note = -1;
    s.sustained = s.mono = s.legato = false;
    s.fade = 1;
    s.level = 0;
    s.quietSamples = 0;
    s.polyAT = 0;
    for (auto& e : s.envs) e.reset();
  }

  // ------------------------------------------------------------ process

  void process(float* const* outs, int nOut, int total, const MidiEvent* ev, int nEv, const HostTransport& host) {
    ScopedNoDenormals nd;
    epoch.blocks.fetch_add(1, std::memory_order_acq_rel);
    if (!prepared) {
      for (int c = 0; c < nOut; ++c) std::memset(outs[c], 0, sizeof(float) * static_cast<std::size_t>(total));
      return;
    }
    int done = 0, ei = 0;
    while (done < total) {
      int n = std::min(total - done, maxBlock);
      int first = ei;
      while (ei < nEv && ev[ei].sample < done + n) ++ei;
      block(outs, nOut, done, n, ev + first, ei - first, host);
      done += n;
    }
  }

  void updateTransport(int offset, int n, const HostTransport& host, bool& jumped) {
    jumped = false;
    if (host.valid) {
      transport.bpm = host.bpm > 1 ? host.bpm : 120;
      transport.timeSigNum = std::max(1, host.timeSigNum);
      transport.timeSigDen = std::max(1, host.timeSigDen);
    }
    transport.playing = host.valid && host.playing;
    spb = sr * 60.0 / transport.bpm;
    if (transport.playing) {
      Beats hb = host.beat + offset / spb;
      double tol = std::max(1e-3, 4.0 / spb);
      jumped = clockStarted && std::fabs(hb - clock) > tol;
      clock = hb;
      double bpb = transport.beatsPerBar();
      transport.barStart = host.barStart + std::floor((hb - host.barStart) / bpb + 1e-9) * bpb;
    } else {
      double bpb = transport.beatsPerBar();
      transport.barStart = std::floor(clock / bpb + 1e-9) * bpb;
    }
    clockStarted = true;
    lastPlaying = transport.playing;
    blockStart = clock;
    blockEnd = clock + n / spb;
    transport.beat = clock;
  }

  void block(float* const* outs, int nOut, int offset, int n, const MidiEvent* ev, int nEv, const HostTransport& host) {
    frames = n;
    if (reqPanic.exchange(0)) {
      for (auto& s : slots) resetSlot(s);
      heldCount = 0;
      sustain = false;
      for (auto& q : queue) q.used = false;
    }
    if (reqAllOff.exchange(0)) allNotesOff();
    // Stepped params (choices, toggles, integers) apply immediately, so a
    // note at the very start of a block already sees e.g. the unison count.
    for (int i = 0; i < store->size(); ++i)
      if (!smoothed[static_cast<std::size_t>(i)]) values[static_cast<std::size_t>(i)] = store->get(i);
    checkMode();

    bool jumped;
    updateTransport(offset, n, host, jumped);

    inCount = 0;
    for (int i = 0; i < nEv; ++i) {
      if (inCount >= static_cast<int>(inEv.size())) { statDropped.fetch_add(1); break; }
      MidiEvent e = ev[i];
      e.sample = std::clamp(e.sample < 0 ? 0 : e.sample - offset, 0, n - 1);
      e.beat = blockStart + e.sample / spb;
      inEv[static_cast<std::size_t>(inCount++)] = e;
    }

    outCount = 0;
    if (jumped) synth->onTransportJump(ectx);
    synth->processEvents(ectx);
    collectDue();
    // Stable insertion sort by sample (small n, no allocation).
    for (int i = 1; i < outCount; ++i) {
      MidiEvent e = outEv[static_cast<std::size_t>(i)];
      int j = i - 1;
      while (j >= 0 && outEv[static_cast<std::size_t>(j)].sample > e.sample) {
        outEv[static_cast<std::size_t>(j + 1)] = outEv[static_cast<std::size_t>(j)];
        --j;
      }
      outEv[static_cast<std::size_t>(j + 1)] = e;
    }

    std::fill(mixL.begin(), mixL.begin() + n, 0.f);
    std::fill(mixR.begin(), mixR.begin() + n, 0.f);
    int pos = 0, oi = 0;
    while (pos < n) {
      while (oi < outCount && outEv[static_cast<std::size_t>(oi)].sample <= pos) handle(outEv[static_cast<std::size_t>(oi++)]);
      int next = std::min(n, pos + kControlBlock);
      if (oi < outCount) next = std::min(next, outEv[static_cast<std::size_t>(oi)].sample);
      sub(pos, next - pos);
      pos = next;
    }
    while (oi < outCount) handle(outEv[static_cast<std::size_t>(oi++)]);

    for (int i = 0; i < n; ++i) {
      if (nOut >= 2) {
        outs[0][offset + i] = mixL[static_cast<std::size_t>(i)];
        outs[1][offset + i] = mixR[static_cast<std::size_t>(i)];
      } else if (nOut == 1) {
        outs[0][offset + i] = 0.5f * (mixL[static_cast<std::size_t>(i)] + mixR[static_cast<std::size_t>(i)]);
      }
    }
    for (int c = 2; c < nOut; ++c) std::memset(outs[c] + offset, 0, sizeof(float) * static_cast<std::size_t>(n));

    clock = blockEnd;
    int active = 0;
    for (auto& s : slots) active += s.state == VoicePool::State::Held || s.state == VoicePool::State::Released;
    statActive.store(active);
    atomicMax(statLimDb, limiter.takeMaxReductionDb());
  }

  void collectDue() {
    for (auto& q : queue) {
      if (!q.used || q.beat >= blockEnd) continue;
      MidiEvent e = q.e;
      e.sample = std::clamp(static_cast<int>(std::floor((q.beat - blockStart) * spb)), 0, frames - 1);
      e.beat = q.beat;
      e.tag = q.tag;
      q.used = false;
      pushOut(e);
    }
  }

  void pushOut(MidiEvent e) {
    if (outCount >= static_cast<int>(outEv.size())) { statDropped.fetch_add(1); return; }
    e.sample = std::clamp(e.sample < 0 ? 0 : e.sample, 0, frames - 1);
    e.beat = blockStart + e.sample / spb;
    outEv[static_cast<std::size_t>(outCount++)] = e;
  }

  bool schedule(Beats beat, MidiEvent e, uint32_t tag) {
    e.tag = tag;
    Scheduled* slot = nullptr;
    for (auto& q : queue) if (!q.used) { slot = &q; break; }
    if (!slot && e.isNoteOff()) {
      // Never lose a note-off: evict the latest pending non-note-off instead.
      for (auto& q : queue)
        if (!q.e.isNoteOff() && (!slot || q.beat > slot->beat)) slot = &q;
    }
    if (!slot) { statDropped.fetch_add(1); return false; }
    slot->beat = beat;
    slot->e = e;
    slot->tag = tag;
    slot->seq = ++seq;
    slot->used = true;
    return true;
  }

  void cancel(uint32_t tag, bool all) {
    for (auto& q : queue) {
      if (!q.used || (!all && q.tag != tag)) continue;
      if (q.e.isNoteOff()) { MidiEvent e = q.e; e.sample = 0; pushOut(e); }
      q.used = false;
    }
  }

  // ------------------------------------------------------------ control-rate step

  void updateParams(int len) {
    int n = store->size();
    for (int i = 0; i < n; ++i) {
      prev[i] = values[i];
      float t = store->get(i);
      if (!smoothed[i]) { values[i] = t; continue; }
      auto& sm = smoothers[i];
      if (t == lastTarget[i] && sm.value() == sm.target()) continue;
      const auto& sp = store->spec(i);
      if (t != lastTarget[i]) { sm.setTarget(static_cast<float>(sp.toNorm(t))); lastTarget[i] = t; }
      float nv = sm.advance(len);
      values[i] = nv == sm.target() ? t : static_cast<float>(sp.fromNorm(nv));
    }
  }

  void sub(int pos, int len) {
    updateParams(len);
    checkMode();
    // MIDI pitch bend arrives in coarse steps; glide it over ~4 ms.
    bend = bendTarget + (bend - bendTarget) * static_cast<float>(std::exp(-len / (0.004 * sr)));
    if (std::fabs(bend - bendTarget) < 1e-5f) bend = bendTarget;

    transport.beat = blockStart + pos / spb;
    double bpb = transport.beatsPerBar();
    while (transport.beat >= transport.barStart + bpb - 1e-9) transport.barStart += bpb;

    for (auto& s : slots)
      if (s.state != VoicePool::State::Free) renderSlot(s, pos, len);

    Buffer io{mixL.data() + pos, mixR.data() + pos, len};
    gctx.values_ = values.data();
    gctx.prev_ = prev.data();
    gctx.frames_ = len;
    synth->processGlobal(gctx, io);

    Ramp master{dsp::dbToGain(prev[pMaster]), dsp::dbToGain(values[pMaster]), len};
    float peak = 0;
    for (int i = 0; i < len; ++i) {
      float g = master.at(i);
      float l = io.left[i] * g, r = io.right[i] * g;
      if (!std::isfinite(l)) l = 0;
      if (!std::isfinite(r)) r = 0;
      peak = std::max(peak, std::max(std::fabs(l), std::fabs(r)));
      limiter.process(l, r);
      io.left[i] = l;
      io.right[i] = r;
    }
    atomicMax(statPeak, peak);
  }

  void renderSlot(Slot& s, int pos, int len) {
    using St = VoicePool::State;
    if (s.glideRate > 0) {
      double step = s.glideRate * len;
      double d = s.basePitch - s.glidePitch;
      if (std::fabs(d) <= step) { s.glidePitch = s.basePitch; s.glideRate = 0; }
      else s.glidePitch += d > 0 ? step : -step;
    }
    for (std::size_t e = 0; e < s.envs.size(); ++e) {
      auto& p = envP[e];
      s.envs[e].set(values[p.a], values[p.d], values[p.s], values[p.r]);
      float velAmt = values[p.vel];
      float scale = 1.f - velAmt + velAmt * s.vel;
      for (int i = 0; i < len; ++i) s.envBuf[e][static_cast<std::size_t>(i)] = s.envs[e].next() * scale;
    }

    std::fill(scratchL.begin(), scratchL.begin() + len, 0.f);
    std::fill(scratchR.begin(), scratchR.begin() + len, 0.f);
    Buffer buf{scratchL.data(), scratchR.data(), len};
    vctx.values_ = values.data();
    vctx.prev_ = prev.data();
    vctx.frames_ = len;
    vctx.slot_ = &s;
    s.voice->render(vctx, buf);

    float gl = 1, gr = 1, gain = 1;
    if (s.uniCount > 1) {
      float t = 2.f * s.uniIndex / static_cast<float>(s.uniCount - 1) - 1.f;
      dsp::panGains(t * (pUniSpread >= 0 ? values[pUniSpread] : 0.f), gl, gr);
      gain = 1.f / std::sqrt(static_cast<float>(s.uniCount));
    }
    bool amp = info.features.ampEnv && !s.envs.empty();
    float peak = 0;
    for (int i = 0; i < len; ++i) {
      float g = gain * (amp ? s.envBuf[0][static_cast<std::size_t>(i)] : 1.f);
      if (s.state == St::Fading) { s.fade = std::max(0.f, s.fade - s.fadeStep); g *= s.fade; }
      float l = scratchL[static_cast<std::size_t>(i)] * g * gl;
      float r = scratchR[static_cast<std::size_t>(i)] * g * gr;
      mixL[static_cast<std::size_t>(pos + i)] += l;
      mixR[static_cast<std::size_t>(pos + i)] += r;
      peak = std::max(peak, std::max(std::fabs(l), std::fabs(r)));
    }
    s.level = std::max(peak, s.level * 0.9f);

    bool done = false;
    if (s.state == St::Fading && s.fade <= 0) done = true;
    if (amp && s.envs[0].idle()) done = true;
    if (!s.voice->active()) done = true;
    if (s.state == St::Released) {
      // Released voices with no amp envelope end once they've gone quiet.
      s.quietSamples = peak < 1e-5f ? s.quietSamples + len : 0;
      if (s.quietSamples > static_cast<int>(0.05 * sr)) done = true;
    }
    if (done) resetSlot(s);
  }

  // ------------------------------------------------------------ voice handling

  int uniCount() const { return pUnison >= 0 ? std::clamp(static_cast<int>(std::lround(values[pUnison])), 1, 8) : 1; }

  double tune(const MidiEvent& e, uint64_t serial) {
    dsp::Rng r(dsp::hashSeed(serial, static_cast<uint64_t>(e.note), 0x7u));
    NoteContext nc{e.note, e.vel, e.channel, r, transport};
    double t = synth->tune(e.note, nc);
    return std::isfinite(t) ? std::clamp(t, -24.0, 160.0) : static_cast<double>(e.note);
  }

  void startSlot(int idx, const MidiEvent& e, double tuned, uint64_t serial, int u, int uc, bool mono, double glideFrom) {
    auto& s = slots[static_cast<std::size_t>(idx)];
    bool sounding = s.state != VoicePool::State::Free;
    if (s.state == VoicePool::State::Fading) resetSlot(s);  // hard steal
    s.state = VoicePool::State::Held;
    s.note = e.note;
    s.channel = e.channel;
    s.vel = e.vel;
    s.age = ++ageCounter;
    s.serial = serial;
    s.sustained = false;
    s.legato = false;
    s.mono = mono;
    s.basePitch = tuned;
    setGlide(s, glideFrom);
    s.uniIndex = u;
    s.uniCount = uc;
    s.fade = 1;
    s.level = 1;  // treat new voices as loud until they've rendered, so the
                  // next unison layer or chord note can't steal them
    s.quietSamples = 0;
    s.polyAT = 0;
    s.startBeat = e.beat;
    s.rng.seed(dsp::hashSeed(serial, static_cast<uint64_t>(u), 0x51u));
    for (auto& env : s.envs) env.gate(true);
    StartInfo si;
    si.sounding = sounding;
    s.voice->start(NoteOn{e.note, e.vel, e.channel}, si);
  }

  void setGlide(Slot& s, double from) {
    double gt = pGlide >= 0 ? values[pGlide] : 0;
    if (gt > 0.0005 && std::isfinite(from) && from != s.basePitch) {
      s.glidePitch = from;
      s.glideRate = std::fabs(s.basePitch - from) / (gt * sr);
    } else {
      s.glidePitch = s.basePitch;
      s.glideRate = 0;
    }
  }

  void releaseSlot(Slot& s) {
    if (s.state != VoicePool::State::Held) return;
    if (sustain) { s.sustained = true; return; }
    s.state = VoicePool::State::Released;
    s.sustained = false;
    for (auto& env : s.envs) env.gate(false);
    s.voice->release();
  }

  void releaseAll(bool ignorePedal) {
    bool p = sustain;
    if (ignorePedal) sustain = false;
    for (auto& s : slots) {
      if (s.state == VoicePool::State::Held) { s.sustained = false; releaseSlot(s); }
    }
    sustain = p && !ignorePedal;
    heldCount = 0;
  }

  void allNotesOff() {
    releaseAll(true);
    sustain = false;
  }

  void handle(const MidiEvent& e) {
    using T = MidiEvent::Type;
    if (e.isNoteOn()) { noteOn(e); return; }
    if (e.isNoteOff()) { noteOff(e); return; }
    switch (e.type) {
      case T::CC: {
        ccs[std::clamp(e.cc, 0, 127)] = e.value;
        if (e.cc == 1) modwheel = e.value;
        else if (e.cc == 64) setSustain(e.value >= 0.5f);
        else if (e.cc == 120) { for (auto& s : slots) resetSlot(s); heldCount = 0; }
        else if (e.cc == 123) allNotesOff();
        break;
      }
      case T::PitchBend: bendTarget = std::clamp(e.value, -1.f, 1.f); break;
      case T::ChannelPressure: aftertouch = e.value; break;
      case T::PolyPressure:
        for (auto& s : slots) if (s.note == e.note && s.state != VoicePool::State::Free) s.polyAT = e.value;
        break;
      default: break;
    }
  }

  void setSustain(bool on) {
    if (on == sustain) return;
    sustain = on;
    if (on) return;
    if (mode != Poly && heldCount > 0) {
      for (auto& s : slots) if (s.mono) s.sustained = false;
      return;
    }
    for (auto& s : slots)
      if (s.state == VoicePool::State::Held && s.sustained) { s.sustained = false; releaseSlot(s); }
  }

  void pushHeld(int note) {
    removeHeld(note);
    if (heldCount < 128) held[heldCount++] = note;
  }
  void removeHeld(int note) {
    for (int i = 0; i < heldCount; ++i)
      if (held[i] == note) {
        for (int j = i; j < heldCount - 1; ++j) held[j] = held[j + 1];
        --heldCount;
        return;
      }
  }

  void noteOn(const MidiEvent& e) {
    uint64_t serial = ++serialCounter;
    double tuned = tune(e, serial);
    int uc = uniCount();
    if (mode == Poly) {
      for (int u = 0; u < uc; ++u) {
        int idx = synth->allocateVoice(NoteOn{e.note, e.vel, e.channel}, pool);
        if (idx < 0 || idx >= static_cast<int>(slots.size())) continue;
        startSlot(idx, e, tuned, serial, u, uc, false, tuned);
      }
      return;
    }
    bool othersHeld = heldCount > 0;
    pushHeld(e.note);
    bool any = false;
    for (auto& s : slots) if (s.mono && s.state != VoicePool::State::Free && s.state != VoicePool::State::Fading) any = true;
    if (!any) {
      for (int u = 0; u < uc; ++u) {
        int idx = synth->allocateVoice(NoteOn{e.note, e.vel, e.channel}, pool);
        if (idx < 0 || idx >= static_cast<int>(slots.size())) continue;
        startSlot(idx, e, tuned, serial, u, uc, true, tuned);
      }
      return;
    }
    monoTransition(e.note, e.vel, e.channel, tuned, serial, mode == Legato && othersHeld);
  }

  void monoTransition(int note, float vel, int channel, double tuned, uint64_t serial, bool legato) {
    for (auto& s : slots) {
      if (!s.mono || s.state == VoicePool::State::Free || s.state == VoicePool::State::Fading) continue;
      double from = s.glidePitch;
      s.note = note;
      s.channel = channel;
      s.basePitch = tuned;
      s.serial = serial;
      s.sustained = false;
      s.legato = legato;
      setGlide(s, from);
      if (!legato) {
        s.vel = vel;
        s.startBeat = transport.beat;
        for (auto& env : s.envs) env.gate(true);
      }
      bool wasReleased = s.state == VoicePool::State::Released;
      s.state = VoicePool::State::Held;
      if (wasReleased) for (auto& env : s.envs) env.gate(true);
      StartInfo si;
      si.legato = legato && !wasReleased;
      si.sounding = true;
      s.voice->start(NoteOn{note, vel, channel}, si);
    }
  }

  void noteOff(const MidiEvent& e) {
    if (mode == Poly) {
      uint64_t oldest = UINT64_MAX;
      for (auto& s : slots)
        if (s.state == VoicePool::State::Held && !s.sustained && s.note == e.note && s.channel == e.channel)
          oldest = std::min(oldest, s.serial);
      if (oldest == UINT64_MAX) return;
      for (auto& s : slots)
        if (s.state == VoicePool::State::Held && s.serial == oldest) releaseSlot(s);
      return;
    }
    removeHeld(e.note);
    int current = -1;
    float vel = 0.8f;
    for (auto& s : slots)
      if (s.mono && s.state == VoicePool::State::Held) { current = s.note; vel = s.vel; }
    if (current != e.note) return;
    if (heldCount > 0) {
      int back = held[heldCount - 1];
      MidiEvent b = e;
      b.note = back;
      b.vel = vel;
      uint64_t serial = ++serialCounter;
      monoTransition(back, vel, e.channel, tune(b, serial), serial, mode == Legato);
      return;
    }
    for (auto& s : slots) if (s.mono) releaseSlot(s);
  }
};

}  // namespace detail

// ============================================================== contexts

using detail::Core;

float VoiceContext::pitchHz() const {
  double a4 = core_->pA4 >= 0 ? values_[core_->pA4] : 440.0;
  return dsp::mtof(pitch(), a4);
}
double VoiceContext::pitch() const {
  double p = slot_->glidePitch;
  p += core_->bend * (core_->pBend >= 0 ? values_[core_->pBend] : 2.f);
  if (slot_->uniCount > 1 && core_->pUniDetune >= 0) {
    float t = 2.f * slot_->uniIndex / static_cast<float>(slot_->uniCount - 1) - 1.f;
    p += t * values_[core_->pUniDetune] / 100.0;
  }
  return p;
}
int VoiceContext::key() const { return slot_->note; }
float VoiceContext::velocity() const { return slot_->vel; }
int VoiceContext::channel() const { return slot_->channel; }
bool VoiceContext::released() const { return slot_->state != VoicePool::State::Held; }
bool VoiceContext::legato() const { return slot_->legato; }
float VoiceContext::env(int n) const {
  if (n < 1 || n > static_cast<int>(slot_->envs.size())) return 0;
  return slot_->envBuf[static_cast<std::size_t>(n - 1)][0];
}
const float* VoiceContext::envSamples(int n) const {
  static const std::array<float, kControlBlock> zeros{};
  if (n < 1 || n > static_cast<int>(slot_->envs.size())) return zeros.data();
  return slot_->envBuf[static_cast<std::size_t>(n - 1)].data();
}
int VoiceContext::unisonIndex() const { return slot_->uniIndex; }
int VoiceContext::unisonCount() const { return slot_->uniCount; }
dsp::Rng& VoiceContext::rng() const { return slot_->rng; }
float VoiceContext::modwheel() const { return core_->modwheel; }
float VoiceContext::aftertouch() const { return std::max(core_->aftertouch, slot_->polyAT); }
float VoiceContext::bend() const { return core_->bend; }
float VoiceContext::cc(int n) const { return core_->ccs[std::clamp(n, 0, 127)]; }
Beats VoiceContext::noteAge() const { return core_->transport.beat - slot_->startBeat; }
const Transport& VoiceContext::transport() const { return core_->transport; }
double VoiceContext::sampleRate() const { return core_->sr; }

float GlobalContext::modwheel() const { return core_->modwheel; }
float GlobalContext::cc(int n) const { return core_->ccs[std::clamp(n, 0, 127)]; }
int GlobalContext::activeVoices() const {
  int a = 0;
  for (auto& s : core_->slots) a += s.state == VoicePool::State::Held || s.state == VoicePool::State::Released;
  return a;
}
const Transport& GlobalContext::transport() const { return core_->transport; }
double GlobalContext::sampleRate() const { return core_->sr; }

EventContext::Range EventContext::in() const {
  return Range{core_->inEv.data(), core_->inEv.data() + core_->inCount};
}
void EventContext::out(const MidiEvent& e) { core_->pushOut(e); }
bool EventContext::schedule(Beats beat, const MidiEvent& e, uint32_t tag) { return core_->schedule(beat, e, tag); }
void EventContext::cancel(uint32_t tag) { core_->cancel(tag, false); }
Beats EventContext::now() const { return core_->blockStart; }
Beats EventContext::blockEnd() const { return core_->blockEnd; }
dsp::Rng EventContext::rng(const MidiEvent& e, bool perKey) {
  if (perKey) return dsp::Rng(dsp::hashSeed(static_cast<uint64_t>(e.note), e.channel, 0x5EEDu));
  return dsp::Rng(dsp::hashSeed(++core_->eventSerial, static_cast<uint64_t>(e.note), 0xE7u));
}
const Transport& EventContext::transport() const { return core_->transport; }
float EventContext::get(Param p) const { return core_->values[static_cast<std::size_t>(p.index)]; }
double EventContext::sampleRate() const { return core_->sr; }
int EventContext::pending() const {
  int n = 0;
  for (auto& q : core_->queue) n += q.used;
  return n;
}

void Synth::onTransportJump(EventContext& ctx) { ctx.core_->cancel(0, true); }

int VoicePool::size() const { return static_cast<int>(core_->slots.size()); }
int VoicePool::limit() const { return core_->info.features.voices; }
int VoicePool::activeCount() const {
  int a = 0;
  for (auto& s : core_->slots) a += s.state == State::Held || s.state == State::Released;
  return a;
}
VoicePool::State VoicePool::state(int i) const { return core_->slots[static_cast<std::size_t>(i)].state; }
int VoicePool::note(int i) const { return core_->slots[static_cast<std::size_t>(i)].note; }
uint64_t VoicePool::age(int i) const { return core_->slots[static_cast<std::size_t>(i)].age; }
float VoicePool::level(int i) const { return core_->slots[static_cast<std::size_t>(i)].level; }
int VoicePool::findFree() const {
  for (int i = 0; i < size(); ++i) if (state(i) == State::Free) return i;
  return -1;
}
void VoicePool::fadeOut(int i) {
  auto& s = core_->slots[static_cast<std::size_t>(i)];
  if (s.state == State::Free || s.state == State::Fading) return;
  s.state = State::Fading;
  s.fadeStep = static_cast<float>(1.0 / (0.012 * core_->sr));  // 12 ms
  core_->statSteals.fetch_add(1);
}
int VoicePool::defaultAllocate(const NoteOn&) {
  if (activeCount() >= limit()) {
    // Steal: oldest released voice, else the quietest held one (oldest on ties).
    int victim = -1;
    for (int i = 0; i < size(); ++i)
      if (state(i) == State::Released && (victim < 0 || age(i) < age(victim))) victim = i;
    if (victim < 0)
      for (int i = 0; i < size(); ++i)
        if (state(i) == State::Held &&
            (victim < 0 || level(i) < level(victim) - 1e-4f || (std::fabs(level(i) - level(victim)) <= 1e-4f && age(i) < age(victim))))
          victim = i;
    if (victim >= 0) fadeOut(victim);
  }
  int f = findFree();
  if (f >= 0) return f;
  // Every slot busy (many fades at once): cut the most-faded voice.
  int best = -1;
  for (int i = 0; i < size(); ++i)
    if (state(i) == State::Fading && (best < 0 || core_->slots[static_cast<std::size_t>(i)].fade < core_->slots[static_cast<std::size_t>(best)].fade)) best = i;
  if (best < 0) best = 0;
  core_->resetSlot(core_->slots[static_cast<std::size_t>(best)]);
  return best;
}

// ============================================================== Engine

Engine::Engine(std::unique_ptr<Synth> synth, SynthInfo info)
    : core_(std::make_unique<Core>(std::move(synth), std::move(info))) {}
Engine::~Engine() { core_->epoch.running = false; }

const SynthInfo& Engine::info() const { return core_->info; }
Synth& Engine::synth() { return *core_->synth; }
ParamStore& Engine::params() { return *core_->store; }
const ParamStore& Engine::params() const { return *core_->store; }
void Engine::prepare(double sr, int maxBlock) { core_->prepare(sr, maxBlock); }
void Engine::releaseResources() {
  core_->epoch.running = false;
  for (auto& c : core_->customs) c->collect();
}
void Engine::process(float* const* outs, int nOut, int frames, const MidiEvent* ev, int nEv, const HostTransport& t) {
  core_->process(outs, nOut, frames, ev, nEv, t);
}
void Engine::allNotesOff() { core_->reqAllOff.store(1); }
void Engine::panic() { core_->reqPanic.store(1); }
PatchMeta& Engine::patchMeta() { return core_->meta; }
const Transport& Engine::transport() const { return core_->transport; }

EngineStats Engine::takeStats() {
  EngineStats s;
  s.activeVoices = core_->statActive.load();
  s.limiterReductionDb = core_->statLimDb.exchange(0);
  s.peakBeforeLimiterDb = dsp::gainToDb(core_->statPeak.exchange(0));
  s.droppedEvents = core_->statDropped.exchange(0);
  s.steals = core_->statSteals.exchange(0);
  return s;
}

Json Engine::savePatch() const {
  Json p = Json::object();
  p["synthkit"] = 1;
  p["synth"] = core_->info.id;
  p["patchVersion"] = core_->info.patchVersion;
  p["name"] = core_->meta.name;
  p["author"] = core_->meta.author;
  p["tags"] = Json(core_->meta.tags);
  Json params = Json::object();
  auto& st = *core_->store;
  for (int i = 0; i < st.size(); ++i) params[st.spec(i).id] = static_cast<double>(st.get(i));
  p["params"] = params;
  if (!core_->customs.empty()) {
    Json c = Json::object();
    for (auto& s : core_->customs) c[s->id()] = s->save();
    p["custom"] = c;
  }
  for (auto& m : core_->extra.members()) p[m.first] = m.second;
  return p;
}

LoadResult Engine::loadPatch(const Json& in) {
  LoadResult r;
  if (!in.isObject()) { r.ok = false; r.error = "patch is not a JSON object"; return r; }
  std::string sid = in["synth"].string("");
  if (!sid.empty() && sid != core_->info.id) {
    r.ok = false;
    r.error = "patch is for synth '" + sid + "', not '" + core_->info.id + "'";
    return r;
  }
  Json j = in;
  int pv = static_cast<int>(j["patchVersion"].number(core_->info.patchVersion));
  if (pv < core_->info.patchVersion) {
    PatchData pd(j);
    core_->synth->migratePatch(pv, pd);
  } else if (pv > core_->info.patchVersion) {
    r.warnings.push_back("patch was saved by a newer version (patchVersion " + std::to_string(pv) + ")");
  }
  auto& st = *core_->store;
  const Json& params = j["params"];
  for (int i = 0; i < st.size(); ++i) {
    const Json& v = params[st.spec(i).id];
    st.set(i, v.isNumber() || v.isBool() ? v.number() : st.spec(i).def);
  }
  for (auto& m : params.members())
    if (st.find(m.first) < 0) r.warnings.push_back("unknown parameter '" + m.first + "' ignored");
  for (auto& c : core_->customs) c->load(j["custom"][c->id()]);
  for (auto& m : j["custom"].members()) {
    bool known = false;
    for (auto& c : core_->customs) known |= c->id() == m.first;
    if (!known) r.warnings.push_back("unknown custom state '" + m.first + "' ignored");
  }
  core_->meta.name = j["name"].string("Untitled");
  core_->meta.author = j["author"].string("");
  core_->meta.tags.clear();
  for (auto& t : j["tags"].items()) core_->meta.tags.push_back(t.string());
  core_->extra = Json::object();
  for (const char* k : {"mod", "shapes"})
    if (j.contains(k)) core_->extra[k] = j[k];
  return r;
}

Json Engine::customState(const std::string& id) const {
  for (auto& c : core_->customs) if (c->id() == id) return c->save();
  return Json();
}
bool Engine::setCustomState(const std::string& id, const Json& v) {
  for (auto& c : core_->customs)
    if (c->id() == id) { c->load(v); return true; }
  return false;
}
std::vector<std::string> Engine::customIds() const {
  std::vector<std::string> ids;
  for (auto& c : core_->customs) ids.push_back(c->id());
  return ids;
}

}  // namespace sk
