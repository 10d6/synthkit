// Multi: parts (Engines), zones, the router and the mix. API.md §5b.
//
// The audio thread reads a MultiLayout through a triple buffer (the control
// thread writes, the audio thread picks up the newest at each block), and a
// note's route table, so a note-off goes where its note-on went, whatever the
// layout says by then.
#include "synthkit/multi.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "synthkit/dsp/util.h"
#include "synthkit/dsp/misc.h"
#include "synthkit/error.h"

namespace sk {

namespace {

constexpr float kPi = 3.14159265358979f;
constexpr int kMaxRoutes = 16;      // sounding zones per key (a note held twice counts twice)
constexpr int kEventsPerPart = 4096;

void atomicMax(std::atomic<float>& a, float v) {
  float cur = a.load(std::memory_order_relaxed);
  while (v > cur && !a.compare_exchange_weak(cur, v, std::memory_order_relaxed)) {}
}

// What the audio thread needs of a layout, derived on the control thread.
struct Rt {
  struct Z { Zone z; float gain = 1; };
  int parts = 1;
  int zoneCount = 0;
  std::array<Z, kMaxZones> zones{};
  std::array<float, kMaxParts> gainL{}, gainR{};
  std::array<uint32_t, kMaxParts> listens{};   // input channels (bit n) whose CCs, bend and pressure reach the part
};

Rt makeRt(const MultiLayout& l) {
  Rt rt;
  rt.parts = l.parts;
  rt.zoneCount = static_cast<int>(l.zones.size());
  for (int i = 0; i < rt.zoneCount; ++i) {
    rt.zones[static_cast<std::size_t>(i)].z = l.zones[static_cast<std::size_t>(i)];
    rt.zones[static_cast<std::size_t>(i)].gain = dsp::dbToGain(l.zones[static_cast<std::size_t>(i)].gainDb);
  }
  bool anySolo = false;
  for (int p = 0; p < l.parts; ++p) anySolo |= l.part[static_cast<std::size_t>(p)].solo;
  for (int p = 0; p < kMaxParts; ++p) {
    const PartSettings& s = l.part[static_cast<std::size_t>(p)];
    const bool audible = anySolo ? s.solo : !s.mute;
    const float g = audible && p < l.parts ? dsp::dbToGain(s.levelDb) : 0.f;
    const float pan = std::clamp(s.pan, -1.f, 1.f);
    rt.gainL[static_cast<std::size_t>(p)] = g * (pan > 0 ? std::cos(pan * kPi * 0.5f) : 1.f);
    rt.gainR[static_cast<std::size_t>(p)] = g * (pan < 0 ? std::cos(-pan * kPi * 0.5f) : 1.f);
    uint32_t mask = 0;
    for (const Zone& z : l.zones)
      if (z.part == p) mask |= z.channel < 0 ? 0xFFFFu : 1u << z.channel;
    rt.listens[static_cast<std::size_t>(p)] = mask;
  }
  return rt;
}

}  // namespace

float zoneFade(int pos, int lo, int hi, int in, int out, bool linear) {
  if (pos < lo || pos > hi) return 0.f;
  float t = 1.f;
  if (in > 0 && pos < lo + in) t = std::min(t, static_cast<float>(pos - lo + 1) / static_cast<float>(in + 1));
  if (out > 0 && pos > hi - out) t = std::min(t, static_cast<float>(hi - pos + 1) / static_cast<float>(out + 1));
  return linear ? t : std::sin(t * kPi * 0.5f);
}

// ============================================================== Impl

struct Multi::Impl {
  struct Route { uint8_t part = 0, note = 0; uint32_t serial = 0; };
  struct Key { uint8_t count = 0; std::array<Route, kMaxRoutes> r{}; };

  std::vector<std::unique_ptr<Engine>> engines;
  SynthInfo info;
  bool prepared = false;
  double sr = 48000;
  int maxBlock = 512;

  // The layout: the control thread's copy, and the triple buffer to the audio thread.
  MultiLayout layout;
  std::array<Rt, 3> slots;
  int front = 0, back = 1;
  std::atomic<int> mid{2};          // the middle slot, with bit 3 set when it's new
  Rt* rt = nullptr;                 // what the audio thread is using (slots[front])

  PresetResolver resolver;

  // Audio thread state.
  std::vector<Key> keys = std::vector<Key>(16 * 128);
  uint32_t serial = 0;
  std::array<std::vector<MidiEvent>, kMaxParts> events;
  std::array<int, kMaxParts> drain{};
  std::array<float, kMaxParts> prevL{}, prevR{};
  std::vector<float> partL, partR, mixL, mixR;
  dsp::Limiter limiter;
  std::atomic<int> reqAllOff{0}, reqPanic{0};
  std::atomic<float> statPeak{0}, statLimDb{0};
  std::atomic<int> statDropped{0};

  void publish() {
    slots[static_cast<std::size_t>(back)] = makeRt(layout);
    int old = mid.exchange(back | 8, std::memory_order_acq_rel);
    back = old & 7;
  }

  // Block start: take the newest layout, and deal with parts that fell out of use.
  void pickLayout() {
    if (mid.load(std::memory_order_relaxed) & 8) {
      int old = mid.exchange(front, std::memory_order_acq_rel);
      const int before = rt->parts;
      front = old & 7;
      rt = &slots[static_cast<std::size_t>(front)];
      for (int p = rt->parts; p < before; ++p) retire(p);
    }
  }

  // A part leaves the multi: its notes stop (a hard stop, which is what taking
  // a part away means) and routes to it go.
  void retire(int p) {
    engines[static_cast<std::size_t>(p)]->panic();
    drain[static_cast<std::size_t>(p)] = 2;
    for (Key& k : keys) {
      int w = 0;
      for (int i = 0; i < k.count; ++i)
        if (k.r[static_cast<std::size_t>(i)].part != p) k.r[static_cast<std::size_t>(w++)] = k.r[static_cast<std::size_t>(i)];
      k.count = static_cast<uint8_t>(w);
    }
  }

  void push(int part, MidiEvent e, int sample) {
    auto& v = events[static_cast<std::size_t>(part)];
    if (v.size() >= v.capacity()) { statDropped.fetch_add(1, std::memory_order_relaxed); return; }
    e.sample = sample;
    v.push_back(e);
  }

  Key& key(const MidiEvent& e) { return keys[static_cast<std::size_t>((e.channel & 15) * 128 + (e.note & 127))]; }

  void route(const MidiEvent& e, int sample) {
    switch (e.type) {
      case MidiEvent::Type::NoteOn:
        if (e.vel > 0) { noteOn(e, sample); break; }
        [[fallthrough]];
      case MidiEvent::Type::NoteOff: noteOff(e, sample); break;
      case MidiEvent::Type::PolyPressure: {
        Key& k = key(e);
        for (int i = 0; i < k.count; ++i) {
          MidiEvent o = e;
          o.note = k.r[static_cast<std::size_t>(i)].note;
          push(k.r[static_cast<std::size_t>(i)].part, o, sample);
        }
        break;
      }
      default:
        for (int p = 0; p < rt->parts; ++p)
          if (rt->listens[static_cast<std::size_t>(p)] & (1u << (e.channel & 15))) push(p, e, sample);
    }
  }

  void noteOn(const MidiEvent& e, int sample) {
    const int vel = std::clamp(static_cast<int>(std::lround(e.vel * 127.f)), 1, 127);
    Key& k = key(e);
    ++serial;
    for (int i = 0; i < rt->zoneCount; ++i) {
      const Rt::Z& rz = rt->zones[static_cast<std::size_t>(i)];
      const Zone& z = rz.z;
      if (z.channel >= 0 && z.channel != (e.channel & 15)) continue;
      const float kf = zoneFade(e.note, z.keyLo, z.keyHi, z.keyFadeIn, z.keyFadeOut, z.linearFade);
      const float vf = zoneFade(vel, z.velLo, z.velHi, z.velFadeIn, z.velFadeOut, z.linearFade);
      const float g = kf * vf * rz.gain;
      if (g < 1e-4f || k.count >= kMaxRoutes) continue;
      MidiEvent o = e;
      o.note = std::clamp(e.note + z.transpose, 0, 127);
      o.gain = e.gain * g;
      push(z.part, o, sample);
      k.r[k.count++] = Route{static_cast<uint8_t>(z.part), static_cast<uint8_t>(o.note), serial};
    }
  }

  // Releases the oldest note held on this key: all the parts it started, like
  // an engine pairing a note-off with its oldest held voice.
  void noteOff(const MidiEvent& e, int sample) {
    Key& k = key(e);
    if (k.count == 0) return;
    uint32_t oldest = k.r[0].serial;
    for (int i = 1; i < k.count; ++i) oldest = std::min(oldest, k.r[static_cast<std::size_t>(i)].serial);
    int w = 0;
    for (int i = 0; i < k.count; ++i) {
      const Route r = k.r[static_cast<std::size_t>(i)];
      if (r.serial == oldest) {
        MidiEvent o = e;
        o.type = MidiEvent::Type::NoteOff;
        o.note = r.note;
        push(r.part, o, sample);
      } else {
        k.r[static_cast<std::size_t>(w++)] = r;
      }
    }
    k.count = static_cast<uint8_t>(w);
  }

  void clearRoutes() {
    for (Key& k : keys) k.count = 0;
  }
};

// ============================================================== Multi

Multi::Multi(const EngineFactory& make, int maxParts) : impl_(std::make_unique<Impl>()) {
  maxParts = std::clamp(maxParts, 1, kMaxParts);
  for (int i = 0; i < maxParts; ++i) impl_->engines.push_back(make());
  impl_->info = impl_->engines[0]->info();
  if (!impl_->info.features.multi) fail("synth.json: features.multi is not enabled for '" + impl_->info.id + "'");
  impl_->layout.parts = 1;
  impl_->layout.zones.push_back(Zone{});
  for (auto& s : impl_->slots) s = makeRt(impl_->layout);
  impl_->rt = &impl_->slots[0];
  for (auto& e : impl_->engines) e->setLimiterEnabled(false);
}

Multi::~Multi() = default;

const SynthInfo& Multi::info() const { return impl_->info; }
int Multi::maxParts() const { return static_cast<int>(impl_->engines.size()); }
Engine& Multi::part(int i) { return *impl_->engines[static_cast<std::size_t>(std::clamp(i, 0, maxParts() - 1))]; }
const Engine& Multi::part(int i) const { return *impl_->engines[static_cast<std::size_t>(std::clamp(i, 0, maxParts() - 1))]; }
const MultiLayout& Multi::layout() const { return impl_->layout; }
void Multi::setPresetResolver(PresetResolver r) { impl_->resolver = std::move(r); }

void Multi::prepare(double sampleRate, int maxBlock) {
  Impl& m = *impl_;
  m.sr = sampleRate;
  m.maxBlock = std::max(1, maxBlock);
  for (auto& e : m.engines) e->prepare(sampleRate, m.maxBlock);
  const std::size_t n = static_cast<std::size_t>(m.maxBlock);
  m.partL.assign(n, 0.f);
  m.partR.assign(n, 0.f);
  m.mixL.assign(n, 0.f);
  m.mixR.assign(n, 0.f);
  for (auto& v : m.events) { v.clear(); v.reserve(kEventsPerPart); }
  m.limiter.prepare(static_cast<float>(sampleRate));
  m.clearRoutes();
  m.drain.fill(0);
  for (int p = 0; p < kMaxParts; ++p) {
    m.prevL[static_cast<std::size_t>(p)] = m.rt->gainL[static_cast<std::size_t>(p)];
    m.prevR[static_cast<std::size_t>(p)] = m.rt->gainR[static_cast<std::size_t>(p)];
  }
  m.prepared = true;
}

void Multi::releaseResources() {
  impl_->prepared = false;
  for (auto& e : impl_->engines) e->releaseResources();
}

void Multi::allNotesOff() {
  impl_->reqAllOff.store(1);
  for (auto& e : impl_->engines) e->allNotesOff();
}
void Multi::panic() {
  impl_->reqPanic.store(1);
  for (auto& e : impl_->engines) e->panic();
}

void Multi::process(float* const* outs, int nOut, int frames, const MidiEvent* ev, int nEv, const HostTransport& host) {
  Impl& m = *impl_;
  if (!m.prepared) {
    for (int c = 0; c < nOut; ++c) std::memset(outs[c], 0, sizeof(float) * static_cast<std::size_t>(frames));
    return;
  }
  m.pickLayout();
  const bool stopped = m.reqAllOff.exchange(0) != 0;
  if (m.reqPanic.exchange(0) != 0 || stopped) m.clearRoutes();

  const double bpm = host.bpm > 1 ? host.bpm : 120;
  const int nParts = static_cast<int>(m.engines.size());
  float peak = 0;
  int done = 0, ei = 0;
  while (done < frames) {
    const int n = std::min(frames - done, m.maxBlock);
    HostTransport t = host;
    if (host.valid && host.playing) t.beat = host.beat + done * bpm / 60.0 / m.sr;

    for (auto& v : m.events) v.clear();
    while (ei < nEv && std::max(0, ev[ei].sample) < done + n) {
      m.route(ev[ei], std::max(0, ev[ei].sample) - done);
      ++ei;
    }

    std::fill(m.mixL.begin(), m.mixL.begin() + n, 0.f);
    std::fill(m.mixR.begin(), m.mixR.begin() + n, 0.f);
    for (int p = 0; p < nParts; ++p) {
      Engine& e = *m.engines[static_cast<std::size_t>(p)];
      const auto sp = static_cast<std::size_t>(p);
      if (p >= m.rt->parts) {
        if (m.drain[sp] > 0) {
          float* o[2] = {m.partL.data(), m.partR.data()};
          e.process(o, 2, n, nullptr, 0, t);          // the hard stop takes effect; nothing is mixed
          --m.drain[sp];
        } else {
          e.advanceClock(n, t);
        }
        continue;
      }
      float* o[2] = {m.partL.data(), m.partR.data()};
      auto& pe = m.events[sp];
      e.process(o, 2, n, pe.data(), static_cast<int>(pe.size()), t);
      const float gl0 = m.prevL[sp], gr0 = m.prevR[sp], gl1 = m.rt->gainL[sp], gr1 = m.rt->gainR[sp];
      if (gl0 == gl1 && gr0 == gr1) {
        for (int i = 0; i < n; ++i) {
          m.mixL[static_cast<std::size_t>(i)] += m.partL[static_cast<std::size_t>(i)] * gl1;
          m.mixR[static_cast<std::size_t>(i)] += m.partR[static_cast<std::size_t>(i)] * gr1;
        }
      } else {
        const float inv = 1.f / static_cast<float>(n);   // a click-free change of level, over this chunk
        for (int i = 0; i < n; ++i) {
          const float f = static_cast<float>(i + 1) * inv;
          m.mixL[static_cast<std::size_t>(i)] += m.partL[static_cast<std::size_t>(i)] * (gl0 + (gl1 - gl0) * f);
          m.mixR[static_cast<std::size_t>(i)] += m.partR[static_cast<std::size_t>(i)] * (gr0 + (gr1 - gr0) * f);
        }
      }
      m.prevL[sp] = gl1;
      m.prevR[sp] = gr1;
    }
    for (int p = m.rt->parts; p < nParts; ++p) {   // an unused part keeps its gains at rest
      m.prevL[static_cast<std::size_t>(p)] = m.rt->gainL[static_cast<std::size_t>(p)];
      m.prevR[static_cast<std::size_t>(p)] = m.rt->gainR[static_cast<std::size_t>(p)];
    }

    for (int i = 0; i < n; ++i) {
      float l = m.mixL[static_cast<std::size_t>(i)], r = m.mixR[static_cast<std::size_t>(i)];
      if (!std::isfinite(l)) l = 0;
      if (!std::isfinite(r)) r = 0;
      peak = std::max(peak, std::max(std::fabs(l), std::fabs(r)));
      m.limiter.process(l, r);
      if (nOut >= 2) {
        outs[0][done + i] = l;
        outs[1][done + i] = r;
      } else if (nOut == 1) {
        outs[0][done + i] = 0.5f * (l + r);
      }
    }
    for (int c = 2; c < nOut; ++c) std::memset(outs[c] + done, 0, sizeof(float) * static_cast<std::size_t>(n));
    done += n;
  }
  atomicMax(m.statPeak, peak);
  atomicMax(m.statLimDb, m.limiter.takeMaxReductionDb());
}

std::vector<std::string> Multi::setLayout(const MultiLayout& in) {
  Impl& m = *impl_;
  std::vector<std::string> warnings;
  MultiLayout l;
  l.parts = std::clamp(in.parts, 1, maxParts());
  if (l.parts != in.parts) warnings.push_back("parts limited to " + std::to_string(l.parts));
  for (int p = 0; p < kMaxParts; ++p) {
    PartSettings s = in.part[static_cast<std::size_t>(p)];
    s.levelDb = std::clamp(std::isfinite(s.levelDb) ? s.levelDb : 0.f, -120.f, 12.f);
    s.pan = std::clamp(std::isfinite(s.pan) ? s.pan : 0.f, -1.f, 1.f);
    l.part[static_cast<std::size_t>(p)] = s;
  }
  int index = 0;
  for (Zone z : in.zones) {
    ++index;
    if (static_cast<int>(l.zones.size()) >= kMaxZones) {
      warnings.push_back("zone " + std::to_string(index) + " dropped: at most " + std::to_string(kMaxZones) + " zones");
      continue;
    }
    if (z.part < 0 || z.part >= l.parts) {
      warnings.push_back("zone " + std::to_string(index) + " dropped: part " + std::to_string(z.part + 1) + " isn't in use");
      continue;
    }
    z.keyLo = std::clamp(z.keyLo, 0, 127);
    z.keyHi = std::clamp(z.keyHi, 0, 127);
    if (z.keyLo > z.keyHi) std::swap(z.keyLo, z.keyHi);
    z.velLo = std::clamp(z.velLo, 1, 127);
    z.velHi = std::clamp(z.velHi, 1, 127);
    if (z.velLo > z.velHi) std::swap(z.velLo, z.velHi);
    z.keyFadeIn = std::clamp(z.keyFadeIn, 0, 127);
    z.keyFadeOut = std::clamp(z.keyFadeOut, 0, 127);
    z.velFadeIn = std::clamp(z.velFadeIn, 0, 127);
    z.velFadeOut = std::clamp(z.velFadeOut, 0, 127);
    z.channel = std::clamp(z.channel, -1, 15);
    z.transpose = std::clamp(z.transpose, -48, 48);
    z.gainDb = std::clamp(std::isfinite(z.gainDb) ? z.gainDb : 0.f, -120.f, 12.f);
    l.zones.push_back(z);
  }
  m.layout = l;
  m.publish();
  return warnings;
}

EngineStats Multi::takeStats() {
  Impl& m = *impl_;
  EngineStats s;
  for (auto& e : m.engines) {
    EngineStats p = e->takeStats();
    s.activeVoices += p.activeVoices;
    s.droppedEvents += p.droppedEvents;
    s.steals += p.steals;
    s.droppedMessages += p.droppedMessages;
  }
  s.droppedEvents += m.statDropped.exchange(0);
  s.limiterReductionDb = m.statLimDb.exchange(0);
  s.peakBeforeLimiterDb = dsp::gainToDb(m.statPeak.exchange(0));
  return s;
}

// ------------------------------------------------------------ saving and loading

Json Multi::save(const std::string& name) const {
  const Impl& m = *impl_;
  Json j = Json::object();
  j["format"] = "sk.multi";
  j["version"] = 1;
  j["synth"] = m.info.id;
  if (!name.empty()) j["name"] = name;
  Json parts = Json::array();
  for (int p = 0; p < m.layout.parts; ++p) {
    const PartSettings& s = m.layout.part[static_cast<std::size_t>(p)];
    Json o = Json::object();
    o["level"] = s.levelDb;
    o["pan"] = s.pan;
    if (s.mute) o["mute"] = true;
    if (s.solo) o["solo"] = true;
    o["patch"] = m.engines[static_cast<std::size_t>(p)]->savePatch();
    parts.push(o);
  }
  j["parts"] = parts;
  Json zones = Json::array();
  for (const Zone& z : m.layout.zones) {
    Json o = Json::object();
    o["part"] = z.part;
    o["key"] = std::vector<int>{z.keyLo, z.keyHi};
    o["vel"] = std::vector<int>{z.velLo, z.velHi};
    if (z.keyFadeIn || z.keyFadeOut) o["keyFade"] = std::vector<int>{z.keyFadeIn, z.keyFadeOut};
    if (z.velFadeIn || z.velFadeOut) o["velFade"] = std::vector<int>{z.velFadeIn, z.velFadeOut};
    if (z.linearFade) o["curve"] = "linear";
    if (z.channel >= 0) o["channel"] = z.channel;
    if (z.transpose) o["transpose"] = z.transpose;
    if (z.gainDb != 0) o["gain"] = z.gainDb;
    zones.push(o);
  }
  j["zones"] = zones;
  return j;
}

LoadResult Multi::load(const Json& in) {
  Impl& m = *impl_;
  LoadResult r;
  if (!in.isObject()) { r.ok = false; r.error = "multi is not a JSON object"; return r; }
  if (in.contains("format") && in["format"].string() != "sk.multi") {
    r.ok = false;
    r.error = "not a multi (format '" + in["format"].string() + "')";
    return r;
  }
  const std::string sid = in["synth"].string("");
  if (!sid.empty() && sid != m.info.id) {
    r.ok = false;
    r.error = "multi is for synth '" + sid + "', not '" + m.info.id + "'";
    return r;
  }
  if (!in["parts"].isArray() || in["parts"].size() == 0) { r.ok = false; r.error = "multi has no parts"; return r; }

  MultiLayout l;
  l.parts = std::min(static_cast<int>(in["parts"].size()), maxParts());
  if (static_cast<int>(in["parts"].size()) > l.parts)
    r.warnings.push_back("only the first " + std::to_string(l.parts) + " parts were loaded");
  Json init = Json::object();
  init["name"] = "Init";
  for (int p = 0; p < maxParts(); ++p) {
    Engine& e = *m.engines[static_cast<std::size_t>(p)];
    if (p >= l.parts) { e.loadPatch(init); continue; }
    const Json& jp = in["parts"][p];
    PartSettings& s = l.part[static_cast<std::size_t>(p)];
    s.levelDb = static_cast<float>(jp["level"].number(0));
    s.pan = static_cast<float>(jp["pan"].number(0));
    s.mute = jp["mute"].boolean(false);
    s.solo = jp["solo"].boolean(false);
    Json patch;
    if (jp["patch"].isObject()) {
      patch = jp["patch"];
    } else if (jp["preset"].isString()) {
      if (!m.resolver || !m.resolver(jp["preset"].string(), patch))
        r.warnings.push_back("part " + std::to_string(p + 1) + ": no preset '" + jp["preset"].string() + "'");
    }
    LoadResult pr = patch.isObject() ? e.loadPatch(patch) : e.loadPatch(init);
    if (!pr.ok) {
      r.warnings.push_back("part " + std::to_string(p + 1) + ": " + pr.error);
      e.loadPatch(init);
    }
    for (auto& w : pr.warnings) r.warnings.push_back("part " + std::to_string(p + 1) + ": " + w);
  }
  // One tempo for the multi: the first part's.
  double bpm = 0;
  int num = 4, den = 4;
  if (m.engines[0]->patchTempo(bpm, num, den))
    for (int p = 1; p < maxParts(); ++p) m.engines[static_cast<std::size_t>(p)]->setPatchTempo(bpm, num, den);

  if (in["zones"].isArray()) {
    for (auto& jz : in["zones"].items()) {
      Zone z;
      z.part = static_cast<int>(jz["part"].number(0));
      if (jz["key"].isArray()) { z.keyLo = static_cast<int>(jz["key"][0].number(0)); z.keyHi = static_cast<int>(jz["key"][1].number(127)); }
      if (jz["vel"].isArray()) { z.velLo = static_cast<int>(jz["vel"][0].number(1)); z.velHi = static_cast<int>(jz["vel"][1].number(127)); }
      if (jz["keyFade"].isArray()) { z.keyFadeIn = static_cast<int>(jz["keyFade"][0].number(0)); z.keyFadeOut = static_cast<int>(jz["keyFade"][1].number(0)); }
      if (jz["velFade"].isArray()) { z.velFadeIn = static_cast<int>(jz["velFade"][0].number(0)); z.velFadeOut = static_cast<int>(jz["velFade"][1].number(0)); }
      z.linearFade = jz["curve"].string() == "linear";
      z.channel = jz["channel"].isNumber() ? static_cast<int>(jz["channel"].number(-1)) : -1;
      z.transpose = static_cast<int>(jz["transpose"].number(0));
      z.gainDb = static_cast<float>(jz["gain"].number(0));
      l.zones.push_back(z);
    }
  } else {
    for (int p = 0; p < l.parts; ++p) { Zone z; z.part = p; l.zones.push_back(z); }   // no zones: every part plays every key
  }
  for (auto& w : setLayout(l)) r.warnings.push_back(w);
  return r;
}

}  // namespace sk
