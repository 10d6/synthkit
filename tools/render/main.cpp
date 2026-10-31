// <synth>_render: offline rendering and checks for a synthkit synth.
//
//   <synth>_render <scenario.json> [--out file.wav] [--sr N] [--block N]
//   <synth>_render --check <synth dir> [--out <dir>]
//   <synth>_render --params
//
// See API.md §10 for the scenario format.

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <map>
#include <new>
#include <sstream>
#include <string>
#include <vector>

#include "synthkit/engine.h"
#include "wav.h"

namespace fs = std::filesystem;

// ------------------------------------------------------------ allocation tracking
// Every allocation made while the engine is inside process() is counted; the
// audio thread must never allocate.

namespace {
thread_local bool gTrack = false;
std::atomic<long> gAllocs{0};
}  // namespace

void* operator new(std::size_t n) {
  if (gTrack) gAllocs.fetch_add(1, std::memory_order_relaxed);
  if (void* p = std::malloc(n ? n : 1)) return p;
  throw std::bad_alloc();
}
void* operator new[](std::size_t n) { return ::operator new(n); }
void* operator new(std::size_t n, const std::nothrow_t&) noexcept {
  if (gTrack) gAllocs.fetch_add(1, std::memory_order_relaxed);
  return std::malloc(n ? n : 1);
}
void* operator new[](std::size_t n, const std::nothrow_t& t) noexcept { return ::operator new(n, t); }
void operator delete(void* p) noexcept { std::free(p); }
void operator delete[](void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }
void operator delete[](void* p, std::size_t) noexcept { std::free(p); }

namespace {

using sk::Json;

// ------------------------------------------------------------ reporting

int gFailures = 0, gWarnings = 0;

void pass(const std::string& what) { std::printf("  PASS  %s\n", what.c_str()); }
void fail(const std::string& what) { std::printf("  FAIL  %s\n", what.c_str()); ++gFailures; }
void warn(const std::string& what) { std::printf("  WARN  %s\n", what.c_str()); ++gWarnings; }
void info(const std::string& what) { std::printf("        %s\n", what.c_str()); }

std::string db(float v) {
  char b[32];
  std::snprintf(b, sizeof b, "%.1f dB", v);
  return b;
}
float toDb(float g) { return g <= 1e-7f ? -140.f : 20.f * std::log10(g); }

std::string readFile(const fs::path& p) {
  std::ifstream f(p, std::ios::binary);
  if (!f) throw std::runtime_error("cannot read " + p.string());
  std::stringstream ss;
  ss << f.rdbuf();
  return ss.str();
}

// ------------------------------------------------------------ scenarios

struct TimedEvent {
  double seconds = -1, beat = -1;
  sk::MidiEvent e;
  std::string msg;            // a message from the page instead of MIDI
  std::vector<float> values;
};

struct Scenario {
  std::string name;
  Json patch;               // full patch JSON (may be null = defaults)
  Json params = Json::object();
  Json custom = Json::object();
  double bpm = 120;
  int sigNum = 4, sigDen = 4;
  bool playing = false;
  double sampleRate = 48000;
  double length = 2;
  std::vector<TimedEvent> events;
  Json expect = Json::object();
};

Json findPreset(const std::string& path, const fs::path& synthDir) {
  int n = 0;
  const sk::EmbeddedPreset* p = sk::embeddedPresets(n);
  for (int i = 0; i < n; ++i) {
    std::string pp = p[i].path;
    if (pp == path || fs::path(pp).filename().string() == path || fs::path(pp).stem().string() == path)
      return Json::parse(p[i].json);
  }
  fs::path f = synthDir / path;
  if (fs::exists(f)) return Json::parse(readFile(f));
  throw std::runtime_error("patch '" + path + "' not found among presets");
}

Scenario parseScenario(const Json& j, const std::string& name, const fs::path& synthDir) {
  Scenario s;
  s.name = name;
  if (j["patch"].isString()) s.patch = findPreset(j["patch"].string(), synthDir);
  else if (j["patch"].isObject()) s.patch = j["patch"];
  if (j["params"].isObject()) s.params = j["params"];
  if (j["custom"].isObject()) s.custom = j["custom"];
  const Json& t = j["transport"];
  s.bpm = t["bpm"].number(120);
  if (t["timeSig"].isArray()) {
    s.sigNum = static_cast<int>(t["timeSig"][0].number(4));
    s.sigDen = static_cast<int>(t["timeSig"][1].number(4));
  }
  s.playing = t["playing"].boolean(false);
  s.sampleRate = j["sampleRate"].number(48000);
  if (j.contains("lengthBeats")) s.length = j["lengthBeats"].number() * 60.0 / s.bpm;
  else s.length = j["length"].number(2);
  for (auto& ev : j["events"].items()) {
    TimedEvent te;
    if (ev.contains("beat")) te.beat = ev["beat"].number();
    else te.seconds = ev["t"].number(0);
    int ch = static_cast<int>(ev["ch"].number(0));
    if (ev.contains("on")) te.e = sk::NoteOn{static_cast<int>(ev["on"].number()), static_cast<float>(ev["vel"].number(100) / 127.0), ch};
    else if (ev.contains("off")) te.e = sk::NoteOff{static_cast<int>(ev["off"].number()), ch};
    else if (ev.contains("cc")) te.e = sk::CC{static_cast<int>(ev["cc"].number()), static_cast<float>(ev["value"].number(0) / 127.0), ch};
    else if (ev.contains("bend")) {
      te.e.type = sk::MidiEvent::Type::PitchBend;
      te.e.value = static_cast<float>(ev["bend"].number());
    } else if (ev.contains("at")) {
      te.e.type = sk::MidiEvent::Type::ChannelPressure;
      te.e.value = static_cast<float>(ev["at"].number() / 127.0);
    } else if (ev.contains("msg")) {
      te.msg = ev["msg"].string();
      for (auto& v : ev["values"].items()) te.values.push_back(static_cast<float>(v.number()));
    } else {
      throw std::runtime_error(name + ": event needs on/off/cc/bend/at/msg");
    }
    s.events.push_back(te);
  }
  if (j["expect"].isObject()) s.expect = j["expect"];
  return s;
}

// ------------------------------------------------------------ rendering

struct Render {
  std::vector<float> l, r;
  std::vector<float> blockPeakDb;   // pre-limiter, per 512-sample block
  float peakDb = -140, limiterDb = 0;
  int dropped = 0;
  long allocs = 0;
  double cpu = 0;
  double sr = 48000;
  double silentAt = -1;             // when stopping early on silence
};

struct RenderOpts {
  int block = 512;
  double stopWhenSilentAfter = -1;  // seconds; render stops after 0.5 s of silence past this
  double maxLength = -1;
};

std::unique_ptr<sk::Engine> engineFor(const Scenario& s, std::string* err = nullptr) {
  auto eng = sk::makeEngine();
  if (!s.patch.isNull()) {
    auto res = eng->loadPatch(s.patch);
    if (!res.ok) { if (err) *err = res.error; return nullptr; }
  }
  for (auto& m : s.params.members()) {
    int i = eng->params().find(m.first);
    if (i < 0) { if (err) *err = "unknown parameter '" + m.first + "'"; return nullptr; }
    eng->params().set(i, m.second.number());
  }
  for (auto& m : s.custom.members())
    if (!eng->setCustomState(m.first, m.second)) { if (err) *err = "unknown custom state '" + m.first + "'"; return nullptr; }
  return eng;
}

Render render(sk::Engine& eng, const Scenario& s, const RenderOpts& o) {
  Render out;
  out.sr = s.sampleRate;
  int block = std::max(1, o.block);
  eng.prepare(s.sampleRate, block);
  double len = o.maxLength > 0 ? o.maxLength : s.length;
  long total = static_cast<long>(std::ceil(len * s.sampleRate));

  struct Ev { long sample; sk::MidiEvent e; };
  std::vector<Ev> evs;
  // Messages arrive at the start of a block, so blocks are split at each
  // message's time (the result doesn't depend on the block size).
  struct Msg { long sample; int index; std::vector<float> values; };
  std::vector<Msg> msgs;
  for (auto& te : s.events) {
    double sec = te.beat >= 0 ? te.beat * 60.0 / s.bpm : te.seconds;
    long at = static_cast<long>(std::llround(sec * s.sampleRate));
    if (!te.msg.empty()) {
      int idx = eng.messageIndex(te.msg);
      if (idx < 0) throw std::runtime_error(s.name + ": unknown message '" + te.msg + "'");
      msgs.push_back({at, idx, te.values});
    } else {
      evs.push_back({at, te.e});
    }
  }
  std::stable_sort(evs.begin(), evs.end(), [](const Ev& a, const Ev& b) { return a.sample < b.sample; });
  std::stable_sort(msgs.begin(), msgs.end(), [](const Msg& a, const Msg& b) { return a.sample < b.sample; });
  std::size_t mi = 0;

  std::vector<float> bl(static_cast<std::size_t>(block)), br(static_cast<std::size_t>(block));
  std::vector<sk::MidiEvent> blockEv;
  blockEv.reserve(evs.size() + 1);
  std::size_t ei = 0;
  long pos = 0;
  long quiet = 0;
  double quietThresh = std::pow(10.0, -80.0 / 20.0);
  auto t0 = std::chrono::steady_clock::now();
  while (pos < total) {
    while (mi < msgs.size() && msgs[mi].sample <= pos) {
      eng.sendMessage(msgs[mi].index, msgs[mi].values.data(), static_cast<int>(msgs[mi].values.size()));
      ++mi;
    }
    long upTo = std::min<long>(block, total - pos);
    if (mi < msgs.size()) upTo = std::min<long>(upTo, msgs[mi].sample - pos);
    int n = static_cast<int>(upTo);
    blockEv.clear();
    while (ei < evs.size() && evs[ei].sample < pos + n) {
      sk::MidiEvent e = evs[ei].e;
      e.sample = static_cast<int>(std::max<long>(0, evs[ei].sample - pos));
      blockEv.push_back(e);
      ++ei;
    }
    sk::HostTransport ht;
    ht.valid = true;
    ht.bpm = s.bpm;
    ht.playing = s.playing;
    ht.beat = pos / s.sampleRate * s.bpm / 60.0;
    ht.timeSigNum = s.sigNum;
    ht.timeSigDen = s.sigDen;
    double bpb = s.sigNum * 4.0 / s.sigDen;
    ht.barStart = std::floor(ht.beat / bpb + 1e-9) * bpb;
    float* outs[2] = {bl.data(), br.data()};
    gTrack = true;
    eng.process(outs, 2, n, blockEv.data(), static_cast<int>(blockEv.size()), ht);
    gTrack = false;
    auto st = eng.takeStats();
    out.peakDb = std::max(out.peakDb, st.peakBeforeLimiterDb);
    out.limiterDb = std::max(out.limiterDb, st.limiterReductionDb);
    out.dropped += st.droppedEvents;
    out.blockPeakDb.push_back(st.peakBeforeLimiterDb);
    bool silent = true;
    for (int i = 0; i < n; ++i) {
      out.l.push_back(bl[static_cast<std::size_t>(i)]);
      out.r.push_back(br[static_cast<std::size_t>(i)]);
      if (std::fabs(bl[static_cast<std::size_t>(i)]) > quietThresh || std::fabs(br[static_cast<std::size_t>(i)]) > quietThresh) silent = false;
    }
    pos += n;
    if (o.stopWhenSilentAfter >= 0 && pos / s.sampleRate > o.stopWhenSilentAfter) {
      quiet = silent ? quiet + n : 0;
      if (quiet > 0.5 * s.sampleRate) { out.silentAt = (pos - quiet) / s.sampleRate; break; }
    }
  }
  out.cpu = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  out.allocs = gAllocs.exchange(0);
  return out;
}

// ------------------------------------------------------------ analysis

bool allFinite(const Render& r) {
  for (std::size_t i = 0; i < r.l.size(); ++i)
    if (!std::isfinite(r.l[i]) || !std::isfinite(r.r[i])) return false;
  return true;
}

float peakBetween(const Render& r, double t0, double t1) {
  std::size_t a = static_cast<std::size_t>(std::max(0.0, t0 * r.sr));
  std::size_t b = std::min(r.l.size(), static_cast<std::size_t>(std::max(0.0, t1 * r.sr)));
  float p = 0;
  for (std::size_t i = a; i < b; ++i) p = std::max(p, std::max(std::fabs(r.l[i]), std::fabs(r.r[i])));
  return toDb(p);
}

float rmsAt(const Render& r, double t, double window = 0.02) {
  std::size_t a = static_cast<std::size_t>(std::max(0.0, t * r.sr));
  std::size_t b = std::min(r.l.size(), a + static_cast<std::size_t>(window * r.sr));
  double sum = 0;
  for (std::size_t i = a; i < b; ++i) sum += 0.5 * (r.l[i] * r.l[i] + r.r[i] * r.r[i]);
  return b > a ? toDb(static_cast<float>(std::sqrt(sum / static_cast<double>(b - a)))) : -140.f;
}

void basicChecks(const std::string& label, const Render& r) {
  if (!allFinite(r)) fail(label + ": output contains NaN/inf");
  if (r.allocs > 0) fail(label + ": " + std::to_string(r.allocs) + " allocation(s) on the audio thread");
  if (r.dropped > 0) fail(label + ": " + std::to_string(r.dropped) + " event(s) dropped");
}

bool runExpect(const Scenario& s, const Render& r) {
  int before = gFailures;
  basicChecks(s.name, r);
  const Json& x = s.expect;
  double spb = 60.0 / s.bpm;
  auto timeOf = [&](const Json& j) { return j.contains("beat") ? j["beat"].number() * spb : j["t"].number(); };
  if (x.contains("peakBelow")) {
    float lim = static_cast<float>(x["peakBelow"].number());
    if (r.peakDb >= lim) fail(s.name + ": peak " + db(r.peakDb) + " (expected below " + db(lim) + ")");
  }
  if (x.contains("limiterBelow")) {
    float lim = static_cast<float>(x["limiterBelow"].number());
    if (r.limiterDb >= lim) fail(s.name + ": limiter reduced " + db(r.limiterDb) + " (expected below " + db(lim) + ")");
  }
  if (x.contains("soundBy")) {
    double t = x["soundBy"].number();
    if (peakBetween(r, 0, t) < -60) fail(s.name + ": no sound before " + std::to_string(t) + " s");
  }
  if (x.contains("silentAfter")) {
    double t = x["silentAfter"].number();
    float p = peakBetween(r, t, 1e9);
    if (p > -80) fail(s.name + ": not silent after " + std::to_string(t) + " s (peak " + db(p) + ")");
  }
  for (auto& c : x["levelAt"].items()) {
    double t = timeOf(c);
    float lv = rmsAt(r, t, c["window"].number(0.02));
    std::string where = c.contains("beat") ? "beat " + std::to_string(c["beat"].number()) : std::to_string(t) + " s";
    if (c.contains("above") && lv <= c["above"].number()) fail(s.name + ": level at " + where + " is " + db(lv) + ", expected above " + db(static_cast<float>(c["above"].number())));
    if (c.contains("below") && lv >= c["below"].number()) fail(s.name + ": level at " + where + " is " + db(lv) + ", expected below " + db(static_cast<float>(c["below"].number())));
  }
  return gFailures == before;
}

void writeIfAsked(const fs::path& dir, const std::string& name, const Render& r) {
  if (dir.empty()) return;
  fs::create_directories(dir);
  fs::path p = dir / (name + ".wav");
  if (!skr::writeWav(p.string(), r.l, r.r, static_cast<int>(r.sr))) warn("could not write " + p.string());
}

// ------------------------------------------------------------ generic checks

Scenario standardScenario(const Json& patch, double sr) {
  Scenario s;
  s.patch = patch;
  s.sampleRate = sr;
  s.length = 1.25;
  for (int n : {48, 52, 55, 72}) { TimedEvent t; t.seconds = 0; t.e = sk::NoteOn{n, 0.8f}; s.events.push_back(t); }
  TimedEvent mw; mw.seconds = 0.3; mw.e = sk::CC{1, 0.7f}; s.events.push_back(mw);
  TimedEvent b; b.seconds = 0.5; b.e.type = sk::MidiEvent::Type::PitchBend; b.e.value = 0.5f; s.events.push_back(b);
  TimedEvent b0; b0.seconds = 0.8; b0.e.type = sk::MidiEvent::Type::PitchBend; b0.e.value = 0; s.events.push_back(b0);
  for (int n : {48, 52, 55, 72}) { TimedEvent t; t.seconds = 1.0; t.e = sk::NoteOff{n}; s.events.push_back(t); }
  TimedEvent off; off.seconds = 1.2; off.e = sk::CC{123, 0}; s.events.push_back(off);
  return s;
}

void checkTail(const std::string& label, const Render& r) {
  if (r.silentAt < 0) fail(label + ": never went silent after all-notes-off (rendered 30 s)");
}

int runCheck(const fs::path& synthDir, const fs::path& outDir) {
  auto proto = sk::makeEngine();
  const auto& si = proto->info();
  std::printf("%s (%s) — %d parameters\n\n", si.name.c_str(), si.id.c_str(), proto->params().size());
  double audioSeconds = 0, cpuSeconds = 0;

  // Presets: load cleanly and survive a save/load round trip.
  std::printf("Presets\n");
  int np = 0;
  const sk::EmbeddedPreset* presets = sk::embeddedPresets(np);
  std::vector<std::pair<std::string, Json>> loaded;
  for (int i = 0; i < np; ++i) {
    std::string name = fs::path(presets[i].path).stem().string();
    Json pj;
    try { pj = Json::parse(presets[i].json); } catch (std::exception& e) { fail(name + ": " + e.what()); continue; }
    auto e1 = sk::makeEngine();
    auto res = e1->loadPatch(pj);
    if (!res.ok) { fail(name + ": " + res.error); continue; }
    for (auto& w : res.warnings) fail(name + ": " + w);
    Json a = e1->savePatch();
    auto e2 = sk::makeEngine();
    e2->loadPatch(a);
    if (e2->savePatch() != a) fail(name + ": save/load round trip changed the patch");
    else pass(name + ": loads and round-trips");
    loaded.emplace_back(name, pj);
  }
  if (np == 0) warn("no presets in presets/");

  // Scenarios from tests/.
  std::printf("\nScenarios\n");
  std::vector<fs::path> tests;
  if (fs::exists(synthDir / "tests"))
    for (auto& f : fs::directory_iterator(synthDir / "tests"))
      if (f.path().extension() == ".json") tests.push_back(f.path());
  std::sort(tests.begin(), tests.end());
  for (auto& t : tests) {
    std::string name = t.stem().string();
    try {
      Scenario s = parseScenario(Json::parse(readFile(t)), name, synthDir);
      std::string err;
      auto eng = engineFor(s, &err);
      if (!eng) { fail(name + ": " + err); continue; }
      Render r = render(*eng, s, {});
      audioSeconds += s.length; cpuSeconds += r.cpu;
      if (runExpect(s, r)) pass(name + "  (peak " + db(r.peakDb) + ")");
      writeIfAsked(outDir / "tests", name, r);
    } catch (std::exception& e) {
      fail(name + ": " + e.what());
    }
  }
  if (tests.empty()) warn("no scenarios in tests/");

  // Every preset at three sample rates: finite, audible, and silent after
  // all-notes-off.
  std::printf("\nPresets at 44.1 / 48 / 96 kHz\n");
  if (loaded.empty()) loaded.emplace_back("defaults", Json());
  for (auto& [name, pj] : loaded) {
    bool ok = true;
    for (double sr : {44100.0, 48000.0, 96000.0}) {
      Scenario s = standardScenario(pj, sr);
      auto eng = engineFor(s);
      int before = gFailures;
      RenderOpts o;
      o.stopWhenSilentAfter = 1.2;
      o.maxLength = 31.2;
      Render r = render(*eng, s, o);
      audioSeconds += static_cast<double>(r.l.size()) / sr; cpuSeconds += r.cpu;
      std::string label = name + " @ " + std::to_string(static_cast<int>(sr / 1000)) + "k";
      basicChecks(label, r);
      checkTail(label, r);
      if (peakBetween(r, 0, 1.0) < -50) fail(label + ": too quiet (peak " + db(peakBetween(r, 0, 1.0)) + ")");
      if (r.peakDb > 0) warn(label + ": hits the safety limiter (peak " + db(r.peakDb) + " before limiting)");
      ok &= gFailures == before;
      if (sr == 48000.0) writeIfAsked(outDir / "presets", name, r);
      if (sr == 48000.0 && ok) info(name + ": peak " + db(r.peakDb) + ", silent " + std::to_string(r.silentAt - 1.2).substr(0, 4) + " s after all-notes-off");
    }
    if (ok) pass(name + ": all sample rates");
  }

  // Block size: rendering in odd block sizes must sound the same.
  std::printf("\nBlock sizes\n");
  {
    Scenario s = standardScenario(loaded.front().second, 48000);
    s.length = 1.5;
    std::vector<Render> rs;
    for (int bs : {512, 1, 37, 4096}) {
      auto eng = engineFor(s);
      RenderOpts o;
      o.block = bs;
      rs.push_back(render(*eng, s, o));
      basicChecks("block " + std::to_string(bs), rs.back());
    }
    float worst = 0;
    for (std::size_t k = 1; k < rs.size(); ++k)
      for (double t = 0; t < 1.4; t += 0.05)
        worst = std::max(worst, std::fabs(rmsAt(rs[0], t, 0.05) - rmsAt(rs[k], t, 0.05)));
    if (worst > 1.5f) fail("loudness differs by " + db(worst) + " between block sizes 512/1/37/4096");
    else pass("blocks of 512, 1, 37 and 4096 samples match (within " + db(worst) + ")");
  }

  // Random patches: nothing blows up, everything ends.
  std::printf("\nRandom patches\n");
  {
    sk::dsp::Rng rng(12345);
    int bad = 0, hot = 0;
    const int count = 25;
    for (int k = 0; k < count; ++k) {
      Scenario s = standardScenario(Json(), 48000);
      auto eng = engineFor(s);
      auto& ps = eng->params();
      for (int i = 0; i < ps.size(); ++i) {
        if (ps.spec(i).id == "master") continue;
        ps.setNorm(i, rng.uniform());
      }
      // Random modulation routes and shape curves too.
      if (eng->modSlots() > 0) {
        auto srcs = eng->modSources();
        std::vector<std::string> dsts;
        for (int i = 0; i < ps.size(); ++i) if (ps.spec(i).modulatable) dsts.push_back(ps.spec(i).id);
        Json routes = Json::array();
        for (int k2 = 0; k2 < eng->modSlots() && !dsts.empty(); ++k2) {
          Json r = Json::object();
          r["src"] = srcs[static_cast<std::size_t>(rng.integer(0, static_cast<int>(srcs.size()) - 1))].id;
          r["dst"] = dsts[static_cast<std::size_t>(rng.integer(0, static_cast<int>(dsts.size()) - 1))];
          r["amt"] = rng.bipolar();
          if (rng.chance(0.3f)) r["via"] = srcs[static_cast<std::size_t>(rng.integer(0, static_cast<int>(srcs.size()) - 1))].id;
          routes.push(r);
        }
        eng->setModMatrix(routes);
      }
      if (eng->shapeCount() > 0) {
        Json shapes = Json::array();
        for (int k2 = 0; k2 < eng->shapeCount(); ++k2) {
          Json pts = Json::array();
          int n = rng.integer(2, 12);
          for (int q = 0; q < n; ++q) {
            Json pt = Json::array();
            pt.push(q == 0 ? 0.0 : q == n - 1 ? 1.0 : rng.uniform());
            pt.push(rng.uniform()); pt.push(rng.bipolar()); pt.push(rng.chance(0.3f) ? 1 : 0);
            pts.push(pt);
          }
          Json curve = Json::object();
          curve["points"] = pts;
          if (rng.chance(0.5f)) curve["release"] = rng.uniform();
          Json sh = Json::object();
          Json curves = Json::array();
          curves.push(curve);
          sh["curves"] = curves;
          shapes.push(sh);
        }
        eng->setShapes(shapes);
      }
      RenderOpts o;
      o.stopWhenSilentAfter = 1.2;
      o.maxLength = 31.2;
      Render r = render(*eng, s, o);
      audioSeconds += static_cast<double>(r.l.size()) / 48000.0; cpuSeconds += r.cpu;
      int before = gFailures;
      std::string label = "random patch " + std::to_string(k);
      basicChecks(label, r);
      checkTail(label, r);
      if (gFailures != before) {
        ++bad;
        writeIfAsked(outDir / "failures", label, r);
        std::ofstream(outDir.empty() ? fs::path(label + ".json") : outDir / "failures" / (label + ".json")) << eng->savePatch().dump();
      }
      if (r.peakDb > 12) ++hot;
    }
    if (!bad) pass(std::to_string(count) + " random patches are finite, allocation-free and end in silence");
    if (hot) warn(std::to_string(hot) + " of " + std::to_string(count) + " random patches peak above +12 dB before the limiter");
  }

  std::printf("\nSpeed: %.0fx realtime (%.1f s of audio in %.2f s)\n", cpuSeconds > 0 ? audioSeconds / cpuSeconds : 0.0,
              audioSeconds, cpuSeconds);
  std::printf("%s: %d failure(s), %d warning(s)\n", gFailures ? "FAILED" : "OK", gFailures, gWarnings);
  return gFailures ? 1 : 0;
}

void printParams() {
  auto eng = sk::makeEngine();
  auto& ps = eng->params();
  for (int i = 0; i < ps.size(); ++i) {
    auto& s = ps.spec(i);
    std::printf("%-22s %-24s %s … %s  (default %s)%s\n", s.id.c_str(), s.name.c_str(), s.format(s.min).c_str(),
                s.format(s.max).c_str(), s.format(s.def).c_str(), s.kit ? "  [kit]" : "");
  }
}

}  // namespace

int main(int argc, char** argv) {
  std::vector<std::string> args(argv + 1, argv + argc);
  auto opt = [&](const std::string& name, std::string fallback = "") {
    for (std::size_t i = 0; i + 1 < args.size(); ++i) if (args[i] == name) return args[i + 1];
    return fallback;
  };
  try {
    if (args.empty()) {
      std::printf("usage: %s <scenario.json> [--out file.wav] [--sr N] [--block N]\n"
                  "       %s --check <synth dir> [--out <dir>]\n"
                  "       %s --params\n", argv[0], argv[0], argv[0]);
      return 2;
    }
    if (args[0] == "--params") { printParams(); return 0; }
    if (args[0] == "--check") {
      if (args.size() < 2) { std::printf("--check needs the synth directory\n"); return 2; }
      return runCheck(args[1], opt("--out"));
    }
    fs::path file = args[0];
    fs::path synthDir = file.parent_path();
    while (!synthDir.empty() && !fs::exists(synthDir / "synth.json") && synthDir != synthDir.parent_path()) synthDir = synthDir.parent_path();
    Scenario s = parseScenario(Json::parse(readFile(file)), file.stem().string(), synthDir);
    if (!opt("--sr").empty()) s.sampleRate = std::atof(opt("--sr").c_str());
    std::string err;
    auto eng = engineFor(s, &err);
    if (!eng) { std::printf("%s\n", err.c_str()); return 1; }
    RenderOpts o;
    if (!opt("--block").empty()) o.block = std::atoi(opt("--block").c_str());
    Render r = render(*eng, s, o);
    bool ok = runExpect(s, r);
    std::printf("%s: peak %s before limiter, limiter %s, %.0fx realtime\n", s.name.c_str(), db(r.peakDb).c_str(),
                db(r.limiterDb).c_str(), r.cpu > 0 ? s.length / r.cpu : 0.0);
    std::string out = opt("--out", s.name + ".wav");
    if (!skr::writeWav(out, r.l, r.r, static_cast<int>(s.sampleRate))) { std::printf("could not write %s\n", out.c_str()); return 1; }
    std::printf("wrote %s\n", out.c_str());
    return ok ? 0 : 1;
  } catch (std::exception& e) {
    std::printf("error: %s\n", e.what());
    return 1;
  }
}
