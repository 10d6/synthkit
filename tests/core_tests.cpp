// Unit tests for synthkit core. Deliberately dependency-free: a few macros
// and a test synth defined right here.
#include <synthkit/engine.h>

#include "../core/src/arp.h"   // internal: the scale table, tested directly

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <functional>
#include <string>
#include <vector>

using namespace sk;

static int gFail = 0, gRun = 0;
#define CHECK(cond) do { if (!(cond)) { std::printf("    %s:%d: CHECK(%s) failed\n", __FILE__, __LINE__, #cond); ++gFail; } } while (0)
#define CHECK_NEAR(a, b, tol) do { double _a = (a), _b = (b); if (std::fabs(_a - _b) > (tol)) { std::printf("    %s:%d: %s = %g, expected %g\n", __FILE__, __LINE__, #a, _a, _b); ++gFail; } } while (0)
#define CHECK_THROWS(expr) do { bool _t = false; try { expr; } catch (...) { _t = true; } if (!_t) { std::printf("    %s:%d: expected exception from %s\n", __FILE__, __LINE__, #expr); ++gFail; } } while (0)

static std::vector<std::pair<const char*, std::function<void()>>>& registry() {
  static std::vector<std::pair<const char*, std::function<void()>>> r;
  return r;
}
struct Reg { Reg(const char* n, std::function<void()> f) { registry().emplace_back(n, std::move(f)); } };
#define TEST(name) static void name(); static Reg reg_##name(#name, name); static void name()

// ------------------------------------------------------------ test synth

struct Log {
  struct Start { int note; Beats beat; double pitch; bool legato; bool arp = false; };
  std::vector<Start> starts;
  struct Mod { Beats beat; float value; int key; double pitch; };
  std::vector<Mod> mods;  // ctx.get(mod) each block, per voice
};
static Log gLog;

struct TestSynth;

struct TestVoice : Voice {
  explicit TestVoice(TestSynth& s) : synth(s) {}
  void start(const NoteOn&, const StartInfo& s) override {
    pendingLog = true;
    wasLegato = s.legato;
    wasArp = s.arp;
    if (!s.sounding) phase = 0;
  }
  void render(VoiceContext& ctx, Buffer& out) override;
  TestSynth& synth;
  double phase = 0;
  bool pendingLog = false, wasLegato = false, wasArp = false;
};

struct Table { std::array<float, 128> cents{}; };

struct TestSynth : Synth {
  Param gain, modp;
  ModSource custom;
  float setCustomTo = -1;
  Custom<Table> table;
  bool scheduleFifth = false;
  bool swallowInput = false;  // only scheduled notes sound
  bool triggerShapeOnNote = false;
  int jumps = 0;

  void defineParams(ParamBuilder& b) override {
    gain = b.add("gain").range(0, 1).def(0.5);
    modp = b.add("mod").range(0, 1).def(0).modulatable();
  }
  void defineModSources(ModSourceBuilder& b) override { custom = b.add("test.src").name("Test").perVoice(); }
  void defineCustom(CustomBuilder& b) override {
    table = b.add<Table>("table", {
        .save = [](const Table& t, Json& j) { j["cents"] = t.cents; },
        .load = [](const Json& j, Table& t) { j["cents"].to(t.cents); },
    });
  }
  std::unique_ptr<Voice> makeVoice() override { return std::make_unique<TestVoice>(*this); }
  double tune(int note, const NoteContext&) override { return note + table.read().cents[static_cast<std::size_t>(note)] / 100.0; }
  void processEvents(EventContext& ctx) override {
    for (auto& e : ctx.in()) {
      if (!swallowInput) ctx.out(e);
      if (triggerShapeOnNote && e.isNoteOn() && e.note == 72) ctx.trigger(1);
      if (scheduleFifth && e.isNoteOn()) {
        Beats at = ctx.quantize(e.beat, Division::Eighth) + 0.5;
        ctx.schedule(at, NoteOn{e.note + 7, e.vel}, 1);
        ctx.schedule(at + 0.25, NoteOff{e.note + 7}, 1);
      }
    }
  }
  void onTransportJump(EventContext& ctx) override { ++jumps; Synth::onTransportJump(ctx); }
  std::vector<int> lastHeld;
  int allocateVoice(const NoteOn& n, VoicePool& pool) override {
    int i = pool.defaultAllocate(n);
    lastHeld.clear();
    for (int k = 0; k < pool.size(); ++k)
      if (pool.state(k) == VoicePool::State::Held) lastHeld.push_back(pool.note(k));
    return i;
  }
  void migratePatch(int from, PatchData& p) override {
    if (from < 2) p.renameParam("volume", "gain");
  }
};

void TestVoice::render(VoiceContext& ctx, Buffer& out) {
  if (pendingLog) { gLog.starts.push_back({ctx.key(), ctx.transport().beat, ctx.pitch(), wasLegato, wasArp}); pendingLog = false; }
  if (gLog.mods.size() < gLog.mods.capacity()) gLog.mods.push_back({ctx.transport().beat, ctx.get(synth.modp), ctx.key(), ctx.pitch()});
  if (synth.setCustomTo >= 0) ctx.setSource(synth.custom, synth.setCustomTo);
  double inc = ctx.pitchHz() / ctx.sampleRate();
  float g = ctx.get(synth.gain);
  for (int i = 0; i < out.frames; ++i) {
    out.add(i, g * static_cast<float>(std::sin(6.283185307179586 * phase)));
    phase += inc;
    if (phase >= 1) phase -= 1;
  }
}

static SynthInfo testInfo(const char* extra = "") {
  std::string j = std::string(R"({"id":"test","pluginCode":"Test","vendorCode":"Tst1","patchVersion":2,
    "features":{"voices":4,"voiceModes":["poly","mono","legato"],"unison":true,"standardEnvelopes":2)") + extra + "}}";
  return SynthInfo::fromJson(Json::parse(j));
}

struct Harness {
  std::unique_ptr<Engine> eng;
  TestSynth* synth;
  double sr = 48000;
  HostTransport ht;
  long pos = 0;
  bool accumulateBeats = false;  // add up the beat per block, as the browser does
  double accBeat = 0;
  explicit Harness(int block = 256, const char* extra = "") {
    auto s = std::make_unique<TestSynth>();
    synth = s.get();
    eng = std::make_unique<Engine>(std::move(s), testInfo(extra));
    eng->prepare(sr, block);
    ht.valid = true;
    ht.bpm = 120;
    gLog.starts.clear();
    gLog.mods.clear();
    gLog.mods.reserve(200000);
  }
  int param(const char* id) { return eng->params().find(id); }
  // Render n samples in blocks, delivering `events` at absolute sample times.
  std::vector<float> run(long n, std::vector<std::pair<long, MidiEvent>> events = {}, int block = 256) {
    std::vector<float> out;
    std::vector<float> l(static_cast<std::size_t>(block)), r(static_cast<std::size_t>(block));
    std::size_t ei = 0;
    long end = pos + n;
    while (pos < end) {
      int b = static_cast<int>(std::min<long>(block, end - pos));
      std::vector<MidiEvent> ev;
      while (ei < events.size() && events[ei].first < pos + b) {
        MidiEvent e = events[ei].second;
        e.sample = static_cast<int>(events[ei].first - pos);
        ev.push_back(e);
        ++ei;
      }
      if (ht.playing) ht.beat = accumulateBeats ? accBeat : pos / sr * ht.bpm / 60.0;
      float* o[2] = {l.data(), r.data()};
      eng->process(o, 2, b, ev.data(), static_cast<int>(ev.size()), ht);
      accBeat += (b / sr) * (ht.bpm / 60.0);
      for (int i = 0; i < b; ++i) out.push_back(l[static_cast<std::size_t>(i)]);
      pos += b;
    }
    return out;
  }
};

// ------------------------------------------------------------ JSON

TEST(json_roundtrip) {
  Json j = Json::parse(R"({"a": 1.5, "b": [1, 2, 3], "c": {"d": "héllo \"q\""}, "e": true, "f": null} // note)");
  CHECK_NEAR(j["a"].number(), 1.5, 0);
  CHECK(j["b"].size() == 3);
  CHECK(j["c"]["d"].string() == "h\xC3\xA9llo \"q\"");
  CHECK(j["e"].boolean());
  CHECK(j["f"].isNull());
  CHECK(j["missing"]["deep"].isNull());
  Json k = Json::parse(j.dump());
  CHECK(k == j);
  CHECK(Json::parse(j.dump(0)) == j);
  CHECK(Json(0.2f).dump() == "0.2");
  CHECK(Json(3.0).dump() == "3");
  Json bad;
  std::string err;
  CHECK(!Json::tryParse("{\"a\": 1,\n  \"b\": ]", bad, &err));
  CHECK(err.find("2:8") != std::string::npos);
  CHECK(Json::tryParse("[1, 2]", bad) && bad.size() == 2);
  CHECK_THROWS(Json::parse("{\"a\": }"));
  CHECK_THROWS(Json::parse("[1, 2"));
}

// ------------------------------------------------------------ params

TEST(param_curves_and_format) {
  ParamBuilder b;
  Param c = b.add("cutoff").name("Cutoff").range(20, 20000).log().def(2000).unit("Hz");
  Param t = b.add("time").range(0.001, 2).log().def(0.25).unit("s");
  Param w = b.add("wave").choices({"Saw", "Square"});
  ParamArray d = b.addArray("detune", 12).name("Detune {note}").range(-50, 50).unit("ct");
  ParamStore st(b.finish());
  auto& cs = st.spec(c.index);
  CHECK_NEAR(cs.fromNorm(cs.toNorm(2000)), 2000, 1e-6);
  CHECK_NEAR(cs.toNorm(cs.min * std::sqrt(cs.max / cs.min)), 0.5, 1e-9);
  CHECK(cs.format(2000) == "2 kHz");
  CHECK(cs.format(350) == "350 Hz");
  CHECK(st.spec(t.index).format(0.25) == "250 ms");
  CHECK(st.spec(w.index).format(1) == "Square");
  CHECK(d.size() == 12);
  CHECK(st.spec(d[1].index).id == "detune.1");
  CHECK(st.spec(d[1].index).name == "Detune C#");
  double v;
  CHECK(cs.parse("1.5 kHz", v) && std::fabs(v - 1500) < 1e-9);
  st.set(c.index, 1e9);
  CHECK_NEAR(st.get(c.index), 20000, 1e-3);
}

TEST(param_id_rules) {
  ParamBuilder b;
  CHECK_THROWS(b.add("master"));
  CHECK_THROWS(b.add("env1.attack"));
  CHECK_THROWS(b.add("lfo2.rate"));
  CHECK_THROWS(b.add("sk.x"));
  b.add("osc2.level");  // '.' is fine otherwise
  b.add("envelope");    // not env<n>
  b.add("x");
  b.add("x");
  CHECK_THROWS(b.finish());
}

// ------------------------------------------------------------ time

// A synth can read kit parameters and give them its own defaults.
struct SilentVoice : Voice {
  void start(const NoteOn&, const StartInfo&) override {}
  void render(VoiceContext&, Buffer&) override {}
};
struct KitParamSynth : Synth {
  Param sustain, master;
  void defineParams(ParamBuilder& b) override {
    b.add("x").range(0, 1);
    b.kitDefault("env1.attack", 0.08);
    b.kitDefault("master", -6);
  }
  void prepare(const PrepareInfo& info) override {
    sustain = info.param("env1.sustain");
    master = info.param("master");
  }
  std::unique_ptr<Voice> makeVoice() override { return std::make_unique<SilentVoice>(); }
};

TEST(kit_params_reachable_and_defaults_overridable) {
  auto s = std::make_unique<KitParamSynth>();
  auto* synth = s.get();
  Engine eng(std::move(s), testInfo());
  eng.prepare(48000, 256);
  auto& ps = eng.params();
  CHECK(synth->sustain.valid() && ps.spec(synth->sustain.index).id == "env1.sustain");
  CHECK(ps.spec(synth->master.index).id == "master");
  CHECK(std::fabs(ps.spec(ps.find("env1.attack")).def - 0.08) < 1e-9);
  CHECK(std::fabs(ps.get(ps.find("master")) + 6) < 1e-6);
  ParamBuilder b;
  b.add("own").range(0, 1);
  b.kitDefault("own", 0.5);
  CHECK_THROWS(b.finish());   // not a kit parameter
  ParamBuilder b2;
  b2.kitDefault("env9.attack", 0.1);
  CHECK_THROWS(b2.finish());  // no such parameter
}

TEST(divisions) {
  Division d;
  CHECK(Division::parse("1/8T", d) && std::fabs(d.beats - 1.0 / 3.0) < 1e-12);
  CHECK(Division::parse("1/4.", d) && std::fabs(d.beats - 1.5) < 1e-12);
  CHECK(Division::parse("2 bars", d) && d.bar && d.beats == 2);
  CHECK(Division::Eighth.dotted().name() == "1/8.");
  CHECK(Division::Sixteenth.triplet().name() == "1/16T");
  Transport t;
  t.timeSigNum = 3; t.timeSigDen = 4; t.barStart = 3;
  CHECK_NEAR(quantizeUp(3.1, Division::Bar, t), 6, 1e-12);
  CHECK_NEAR(quantizeUp(1.0, Division::Eighth, t), 1.0, 1e-12);
  CHECK_NEAR(quantizeUp(1.01, Division::Eighth, t), 1.5, 1e-12);
}

// ------------------------------------------------------------ engine

static MidiEvent on(int n, float v = 0.8f) { return NoteOn{n, v}; }
static MidiEvent off(int n) { return NoteOff{n}; }

TEST(scheduled_events_land_on_the_beat) {
  Harness h;
  h.synth->scheduleFifth = true;
  // Note at 0.3 beats (7200 samples at 120 bpm) -> next 1/8 is 0.5, +0.5 = beat 1.0.
  h.run(48000, {{7200, on(60)}});
  CHECK(gLog.starts.size() == 2);
  if (gLog.starts.size() == 2) {
    CHECK(gLog.starts[1].note == 67);
    CHECK_NEAR(gLog.starts[1].beat, 1.0, 1.0 / 24000);
  }
}

// A note scheduled exactly on a sample lands on that sample whatever the
// block sizes are (the beat clock's rounding used to move it by one).
TEST(scheduled_events_ignore_block_boundaries) {
  std::vector<long> onsets;
  for (int block : {256, 37, 100, 129, 1000, 96, 128, 160})
  for (bool accumulate : {false, true}) {
    Harness h(block);
    h.ht.playing = true;
    h.ht.bpm = 96;  // 30000 samples per beat
    h.accumulateBeats = accumulate;
    h.synth->scheduleFifth = true;
    h.synth->swallowInput = true;
    // Key at beat 7.3: the fifth is due at beat 8.0 = sample 240000, after
    // enough blocks for the beat clock's rounding to build up.
    auto out = h.run(250000, {{219000, on(60)}}, block);
    long first = -1;
    for (std::size_t i = 0; i < out.size(); ++i)
      if (out[i] != 0.f) { first = static_cast<long>(i); break; }
    onsets.push_back(first);
  }
  for (long o : onsets) CHECK(o == onsets[0]);
  CHECK(onsets[0] >= 240000 && onsets[0] <= 240002);
}

TEST(polyphony_limit_and_stealing) {
  Harness h;
  std::vector<std::pair<long, MidiEvent>> ev;
  for (int i = 0; i < 6; ++i) ev.push_back({i * 100L, on(60 + i)});
  h.run(4800, ev);
  auto st = h.eng->takeStats();
  CHECK(st.activeVoices == 4);
  CHECK(st.steals == 2);
}

TEST(stealing_never_takes_layers_of_the_new_note) {
  Harness h;  // 4 voices
  h.eng->params().set(h.param("unison"), 2);
  h.run(4800, {{0, on(60)}, {1000, on(64)}, {2000, on(67)}});
  auto st = h.eng->takeStats();
  CHECK(st.activeVoices == 4);
  CHECK(st.steals == 2);
  // At the last allocation (second layer of 67), note 60's layers were the
  // ones stolen: held voices are 64, 64 and the first layer of 67.
  auto& held = h.synth->lastHeld;
  CHECK(held.size() == 3);
  CHECK(std::count(held.begin(), held.end(), 60) == 0);
  CHECK(std::count(held.begin(), held.end(), 64) == 2);
  CHECK(std::count(held.begin(), held.end(), 67) == 1);
}

TEST(unison_uses_one_voice_per_layer) {
  Harness h;
  h.eng->params().set(h.param("unison"), 3);
  h.run(4800, {{0, on(60)}});
  CHECK(h.eng->takeStats().activeVoices == 3);
}

TEST(sustain_pedal_holds_notes) {
  Harness h;
  h.eng->params().set(h.param("env1.release"), 0.01);
  MidiEvent ped = CC{64, 1.f}, up = CC{64, 0.f};
  h.run(48000, {{0, ped}, {10, on(60)}, {4800, off(60)}});
  CHECK(h.eng->takeStats().activeVoices == 1);
  h.run(24000, {{h.pos + 10, up}});
  CHECK(h.eng->takeStats().activeVoices == 0);
}

TEST(mono_and_legato) {
  {
    Harness h;
    h.eng->params().set(h.param("voiceMode"), 2);  // legato
    h.run(24000, {{0, on(60)}, {4800, on(64)}, {9600, off(64)}});
    // 60 starts; 64 is a legato transition; releasing 64 returns to 60 legato.
    CHECK(gLog.starts.size() == 3);
    if (gLog.starts.size() == 3) CHECK(!gLog.starts[0].legato && gLog.starts[1].legato && gLog.starts[2].legato);
    CHECK(h.eng->takeStats().activeVoices == 1);
  }
  {
    Harness h;
    h.eng->params().set(h.param("voiceMode"), 1);  // mono: retriggers
    h.run(24000, {{0, on(60)}, {4800, on(64)}});
    CHECK(gLog.starts.size() == 2);
    if (gLog.starts.size() == 2) CHECK(!gLog.starts[1].legato);
    CHECK(h.eng->takeStats().activeVoices == 1);
  }
}

TEST(tuning_hook_and_custom_state) {
  Harness h;
  Table t;
  t.cents[60] = 50;
  h.synth->table.write(t);
  h.run(4800, {{0, on(60)}});
  CHECK(!gLog.starts.empty());
  if (!gLog.starts.empty()) CHECK_NEAR(gLog.starts[0].pitch, 60.5, 1e-6);
  Json saved = h.eng->savePatch();
  CHECK_NEAR(saved["custom"]["table"]["cents"][60].number(), 50, 1e-6);
  Harness h2;
  CHECK(h2.eng->loadPatch(saved).ok);
  CHECK_NEAR(h2.synth->table.read().cents[60], 50, 1e-6);
  CHECK(h2.eng->savePatch() == saved);
}

TEST(patch_load_migrate_and_warn) {
  Harness h;
  Json p = Json::parse(R"({"synth":"test","patchVersion":1,"params":{"volume":0.25,"bogus":3}})");
  auto r = h.eng->loadPatch(p);
  CHECK(r.ok);
  CHECK_NEAR(h.eng->params().get(h.param("gain")), 0.25, 1e-6);
  CHECK(r.warnings.size() == 1);
  auto bad = h.eng->loadPatch(Json::parse(R"({"synth":"other"})"));
  CHECK(!bad.ok);
}

TEST(transport_jump_flushes_pending) {
  Harness h;
  h.synth->scheduleFifth = true;
  h.ht.playing = true;
  h.run(2400, {{0, on(60)}});  // schedules a note at beat 1.0
  h.pos = 96000;                // host jumps to beat 4
  h.run(48000);
  CHECK(h.synth->jumps == 1);
  CHECK(gLog.starts.size() == 1);  // the scheduled fifth never played
}

TEST(block_size_does_not_change_output) {
  auto render = [](int block) {
    Harness h(block);
    return h.run(24000, {{100, on(60)}, {5000, on(67)}, {12000, off(60)}}, block);
  };
  auto a = render(256), b = render(7), c = render(1000);
  double worst = 0;
  for (std::size_t i = 0; i < a.size(); ++i) worst = std::max({worst, static_cast<double>(std::fabs(a[i] - b[i])), static_cast<double>(std::fabs(a[i] - c[i]))});
  CHECK(worst < 1e-5);
}

TEST(synth_json_validation) {
  CHECK_THROWS(SynthInfo::fromJson(Json::parse(R"({"name":"x"})")));
  CHECK_THROWS(SynthInfo::fromJson(Json::parse(R"({"id":"x","pluginCode":"toolong"})")));
  CHECK_THROWS(SynthInfo::fromJson(Json::parse(R"({"id":"x","features":{"voiceModes":["chord"]}})")));
  auto i = SynthInfo::fromJson(Json::parse(R"({"id":"x"})"));
  CHECK(i.features.voices == 8 && i.features.ampEnv);
}


// ------------------------------------------------------------ modulation

static const char* kMod = R"(,"standardLfos":2,"modSlots":8,"shapes":2)";

// Value of ctx.get(mod) logged nearest to a beat (first voice only).
static float modAt(Beats b, int key = -1) {
  float v = NAN;
  double best = 1e9;
  for (auto& m : gLog.mods)
    if ((key < 0 || m.key == key) && std::fabs(m.beat - b) < best) { best = std::fabs(m.beat - b); v = m.value; }
  return v;
}

static void loadMod(Harness& h, const char* json) {
  Json p = h.eng->savePatch();
  Json extra = Json::parse(json);
  for (auto& m : extra.members()) p[m.first] = m.second;
  auto r = h.eng->loadPatch(p);
  CHECK(r.ok);
  for (auto& w : r.warnings) std::printf("    warning: %s\n", w.c_str());
}

TEST(matrix_routes_and_via) {
  Harness h(256, kMod);
  loadMod(h, R"({"mod":[{"src":"const","dst":"mod","amt":0.25},{"src":"const","dst":"mod","amt":0.5,"via":"modwheel"}]})");
  MidiEvent mw = CC{1, 0.5f};
  h.run(4800, {{0, on(60)}});
  CHECK_NEAR(gLog.mods.back().value, 0.25, 1e-4);
  h.run(4800, {{h.pos, mw}});
  CHECK_NEAR(gLog.mods.back().value, 0.5, 1e-4);  // 0.25 + 0.5 * 0.5
  // Meters report the modulated value for the sounding voice.
  std::vector<float> src(h.eng->modSources().size()), par(static_cast<std::size_t>(h.eng->params().size())), sh(4);
  h.eng->readModMeters(src.data(), par.data(), sh.data());
  CHECK_NEAR(par[static_cast<std::size_t>(h.param("mod"))], 0.5, 1e-4);
  CHECK(std::isnan(par[static_cast<std::size_t>(h.param("gain"))]));
}

TEST(synced_lfo_is_locked_to_the_beat) {
  Harness h(256, kMod);
  auto& ps = h.eng->params();
  ps.set(h.param("lfo1.shape"), 4);     // square
  ps.set(h.param("lfo1.sync"), 1);
  ps.set(h.param("lfo1.division"), 6);  // 1/4
  loadMod(h, R"({"mod":[{"src":"lfo1","dst":"mod","amt":0.5}]})");
  ps.set(h.param("mod"), 0.5);
  // Start the note off the beat: a global synced LFO doesn't care.
  h.run(96000, {{3000, on(60)}});
  CHECK_NEAR(modAt(1.2), 1.0, 1e-3);   // first half of each beat: +1
  CHECK_NEAR(modAt(1.7), 0.0, 1e-3);   // second half: -1
  CHECK_NEAR(modAt(3.25), 1.0, 1e-3);
}

TEST(per_voice_lfo_and_fade) {
  Harness h(256, kMod);
  auto& ps = h.eng->params();
  ps.set(h.param("lfo1.shape"), 4);
  ps.set(h.param("lfo1.mode"), 1);      // per voice: restarts with each note
  ps.set(h.param("lfo1.rate"), 1);      // 1 Hz = 1 cycle per 2 beats at 120 bpm
  ps.set(h.param("lfo1.fade"), 1);      // fades in over a second
  loadMod(h, R"({"mod":[{"src":"lfo1","dst":"mod","amt":1}]})");
  h.run(96000, {{12000, on(60)}});       // note at beat 0.5
  // 1 Hz square from the note (beat 0.5): +1 for beats 0.5–1.5, -1 for 1.5–2.5, …
  CHECK(modAt(0.6) < 0.1);               // just started: faded right down
  CHECK_NEAR(modAt(1.45), 0.475, 0.03);  // 0.475 s in: fade at 47.5%
  CHECK_NEAR(modAt(2.4), 0.0, 1e-3);     // negative half (clamped at 0)
  CHECK_NEAR(modAt(2.75), 1.0, 1e-3);    // positive again, fully faded in
}

TEST(note_shape_quantised_start_and_ramp) {
  Harness h(256, kMod);
  auto& ps = h.eng->params();
  ps.set(h.param("shape1.length"), 7);   // 1/4 = one beat
  ps.set(h.param("shape1.start"), 3);    // wait for the next beat
  loadMod(h, R"({"mod":[{"src":"shape1","dst":"mod","amt":1}],
                 "shapes":[{"curves":[{"points":[[0,0,0,0],[1,1,0,0]]}]}]})");
  h.run(96000, {{6000, on(60)}});        // note at beat 0.25
  CHECK_NEAR(modAt(0.6), 0.0, 1e-3);     // waiting for beat 1
  CHECK_NEAR(modAt(1.5), 0.5, 0.02);     // half way through the ramp
  CHECK_NEAR(modAt(3.0), 1.0, 1e-3);     // "once": holds the end
}

TEST(shape_release_segment) {
  Harness h(256, kMod);
  auto& ps = h.eng->params();
  ps.set(h.param("shape1.length"), 7);   // one beat
  ps.set(h.param("shape1.loop"), 4);     // release
  ps.set(h.param("env1.release"), 2);    // keep the voice alive after key up
  loadMod(h, R"({"mod":[{"src":"shape1","dst":"mod","amt":1}],
                 "shapes":[{"curves":[{"points":[[0,0,0,0],[0.5,1,0,0],[1,0,0,0]],"release":0.5}]}]})");
  h.run(72000, {{0, on(60)}, {48000, off(60)}});  // key up at beat 2
  CHECK_NEAR(modAt(1.5), 1.0, 1e-3);      // holding at the release point
  CHECK_NEAR(modAt(2.25), 0.5, 0.03);     // released: half way down the tail
  CHECK_NEAR(modAt(2.9), 0.0, 1e-3);
}

TEST(shape_curves_with_handles) {
  Harness h(256, kMod);
  auto& ps = h.eng->params();
  ps.set(h.param("shape1.length"), 7);  // one beat
  // S-curve: flat handles a third of the way in from each end. x(t) = t here,
  // so y(0.25) = 3(0.75)(0.25^2) + 0.25^3 = 0.15625.
  loadMod(h, R"({"mod":[{"src":"shape1","dst":"mod","amt":1}],
                 "shapes":[{"curves":[{"points":[[0,0,0,0, 0.3333333,0,0,0,0],[1,1,0,0, 0,0,-0.3333333,0,0]]}]}]})");
  h.run(48000, {{0, on(60)}});
  CHECK_NEAR(modAt(0.25), 0.15625, 0.01);
  CHECK_NEAR(modAt(0.5), 0.5, 0.01);
  CHECK_NEAR(modAt(0.75), 0.84375, 0.01);
  // Handles are kept through save and load.
  Json saved = h.eng->savePatch();
  CHECK(saved["shapes"][0]["curves"][0]["points"][0].size() == 9);
  Harness h2(256, kMod);
  CHECK(h2.eng->loadPatch(saved).ok);
  CHECK(h2.eng->savePatch() == saved);
  // A handle reaching past half the segment is limited, so the curve can't
  // bend back in time: still increasing everywhere.
  Harness h3(256, kMod);
  h3.eng->params().set(h3.param("shape1.length"), 7);
  loadMod(h3, R"({"mod":[{"src":"shape1","dst":"mod","amt":1}],
                  "shapes":[{"curves":[{"points":[[0,0,0,0, 0.9,0.5,0,0,1],[1,1,0,0, 0,0,-0.9,-0.5,1]]}]}]})");
  h3.run(24000, {{0, on(60)}});
  float last = -1;
  bool monotonic = true;
  for (auto& m : gLog.mods) { if (m.value < last - 1e-4f) monotonic = false; last = m.value; }
  CHECK(monotonic);
}

TEST(bar_shape_follows_the_bar) {
  Harness h(256, kMod);
  h.ht.timeSigNum = 3;
  auto& ps = h.eng->params();
  ps.set(h.param("shape1.trigger"), 2);  // bar
  ps.set(h.param("shape1.length"), 4);   // 1 bar
  loadMod(h, R"({"mod":[{"src":"shape1","dst":"mod","amt":1}],
                 "shapes":[{"curves":[{"points":[[0,0,0,0],[1,1,0,0]]}]}]})");
  h.run(192000, {{100, on(60)}});        // 4 s = 8 beats = bars of 3
  CHECK_NEAR(modAt(1.5), 0.5, 0.02);
  CHECK_NEAR(modAt(4.5), 0.5, 0.02);     // second bar starts at beat 3
  CHECK_NEAR(modAt(6.3), 0.1, 0.02);
}

TEST(custom_source_from_the_voice) {
  Harness h(256, kMod);
  loadMod(h, R"({"mod":[{"src":"test.src","dst":"mod","amt":1}]})");
  h.synth->setCustomTo = 0.4f;
  h.run(4800, {{0, on(60)}});
  CHECK_NEAR(gLog.mods.back().value, 0.4, 1e-4);
}

TEST(pitch_and_level_destinations) {
  Harness h(256, kMod);
  loadMod(h, R"({"mod":[{"src":"const","dst":"sk.pitch","amt":0.25}]})");
  h.run(2400, {{0, on(60)}});
  CHECK_NEAR(gLog.mods.back().pitch, 66.0, 1e-3);  // +0.25 of ±12 st = +6
  Harness q(256, kMod);
  loadMod(q, R"({"mod":[{"src":"const","dst":"sk.level","amt":-1}]})");
  auto out = q.run(9600, {{0, on(60)}});
  float peak = 0;
  for (float x : out) peak = std::max(peak, std::fabs(x));
  CHECK(peak < 1e-6);  // voice level pulled to zero
}

TEST(mod_patch_round_trip_and_warnings) {
  Harness h(256, kMod);
  Json p = h.eng->savePatch();
  p["mod"] = Json::parse(R"([{"src":"lfo2","dst":"mod","amt":-0.3,"via":"velocity"},{"src":"nope","dst":"mod","amt":1},{"src":"lfo1","dst":"gain","amt":1}])");
  p["shapes"] = Json::parse(R"([{"curves":[{"points":[[0.2,0.5,0.3,1],[0.8,1,0,0]],"release":0.4}]}])");
  auto r = h.eng->loadPatch(p);
  CHECK(r.ok);
  CHECK(r.warnings.size() == 2);  // unknown source; gain isn't modulatable
  Json saved = h.eng->savePatch();
  CHECK(saved["mod"].size() == 1);
  CHECK(saved["mod"][0]["via"].string() == "velocity");
  // Curves are completed to span 0…1.
  CHECK(saved["shapes"][0]["curves"][0]["points"].size() == 4);
  Harness h2(256, kMod);
  CHECK(h2.eng->loadPatch(saved).ok);
  CHECK(h2.eng->savePatch() == saved);
}

TEST(manual_trigger_from_events) {
  // Covered via the event stage: trigger restarts a shape for held voices.
  Harness h(256, kMod);
  auto& ps = h.eng->params();
  ps.set(h.param("shape1.trigger"), 5);  // manual
  ps.set(h.param("shape1.length"), 7);
  loadMod(h, R"({"mod":[{"src":"shape1","dst":"mod","amt":1}],
                 "shapes":[{"curves":[{"points":[[0,0,0,0],[1,1,0,0]]}]}]})");
  h.synth->triggerShapeOnNote = true;
  h.run(48000, {{0, on(60)}});
  CHECK_NEAR(modAt(1.5, 60), 0.0, 1e-3);     // nothing has triggered it yet
  h.run(48000, {{h.pos, on(72)}});           // key 72 triggers it (beat 2) for held voices
  CHECK_NEAR(modAt(2.5, 60), 0.5, 0.03);
}

TEST(first_note_shape_and_key_range) {
  Harness h(256, kMod);
  auto& ps = h.eng->params();
  ps.set(h.param("shape1.trigger"), 1);  // first note of a phrase
  ps.set(h.param("shape1.length"), 7);
  ps.set(h.param("shape2.length"), 7);
  ps.set(h.param("shape2.keyLow"), 64);  // shape 2 ignores keys below E4
  loadMod(h, R"({"mod":[{"src":"shape1","dst":"mod","amt":0.5},{"src":"shape2","dst":"mod","amt":0.5}],
                 "shapes":[{"curves":[{"points":[[0,0,0,0],[1,1,0,0]]}]},{"curves":[{"points":[[0,1,0,1],[1,1,0,0]]}]}]})");
  // 60 starts the phrase at beat 0; 64 joins at beat 0.5 without restarting shape 1.
  h.run(48000, {{0, on(60)}, {12000, on(64)}});
  CHECK_NEAR(modAt(0.75, 60), 0.375, 0.02);  // shape1 at 0.75, shape2 inactive for key 60
  CHECK_NEAR(modAt(0.75, 64), 0.875, 0.02);  // same shape1, plus shape2 (1.0 × 0.5) for key 64
}

// ------------------------------------------------------------ messages

struct MsgVoice : Voice {
  void start(const NoteOn&, const StartInfo&) override {}
  void render(VoiceContext&, Buffer&) override {}
};
struct MsgSynth : Synth {
  MessageId ping, pong;
  std::vector<std::pair<float, int>> seen;   // (value, count) per message seen
  int blocks = 0;
  void defineParams(ParamBuilder&) override {}
  void defineMessages(MessageBuilder& b) override { ping = b.add("ping"); pong = b.add("pong"); }
  std::unique_ptr<Voice> makeVoice() override { return std::make_unique<MsgVoice>(); }
  void prepare(const PrepareInfo&) override { seen.reserve(1024); }
  void processEvents(EventContext& ctx) override {
    ++blocks;
    for (auto& m : ctx.messages())
      if (m.is(ping)) { seen.push_back({m[1], m.count}); ctx.post(pong, {m[0] * 2}); }
  }
};

TEST(messages_round_trip) {
  auto s = std::make_unique<MsgSynth>();
  MsgSynth* syn = s.get();
  Engine eng(std::move(s), testInfo());
  eng.prepare(48000, 128);
  CHECK(eng.messageIds().size() == 2 && eng.messageIndex("pong") == 1 && eng.messageIndex("nope") == -1);
  std::vector<float> l(128), r(128);
  float* outs[2] = {l.data(), r.data()};
  HostTransport ht;
  const float v[3] = {1.5f, 7, 9};
  CHECK(eng.sendMessage(0, v, 3));
  CHECK(!eng.sendMessage(5, v, 1));            // unknown index
  eng.process(outs, 2, 128, nullptr, 0, ht);
  eng.process(outs, 2, 128, nullptr, 0, ht);   // seen once, not again
  CHECK(syn->seen.size() == 1 && syn->seen[0].first == 7 && syn->seen[0].second == 3);
  Message m;
  CHECK(eng.takeMessage(m) && m.is(syn->pong) && m.count == 1 && m[0] == 3.f);
  CHECK(!eng.takeMessage(m));
  // Order is kept, and a full queue refuses (and counts) instead of growing.
  for (int i = 0; i < 300; ++i) { const float x = static_cast<float>(i); eng.sendMessage(0, &x, 1); }
  CHECK(eng.takeStats().droppedMessages == 300 - 255);
  syn->seen.clear();
  eng.process(outs, 2, 128, nullptr, 0, ht);
  CHECK(syn->seen.size() == 255);
  // ... and the synth's 255 answers came back in order.
  int n = 0;
  bool ordered = true;
  while (eng.takeMessage(m)) { ordered &= m[0] == static_cast<float>(n * 2); ++n; }
  CHECK(n == 255 && ordered);
}

TEST(messages_ids_are_checked) {
  struct Bad : MsgSynth {
    void defineMessages(MessageBuilder& b) override { b.add("ok"); b.add("ok"); }
  };
  CHECK_THROWS(Engine(std::make_unique<Bad>(), testInfo()));
  struct Bad2 : MsgSynth {
    void defineMessages(MessageBuilder& b) override { b.add("has space"); }
  };
  CHECK_THROWS(Engine(std::make_unique<Bad2>(), testInfo()));
}


// ------------------------------------------------------------ the DAW's stand-ins

struct CtlSynth : Synth {
  Param swell, vol, step;
  std::vector<int> ccSeen;   // CC numbers processEvents saw
  bool moveOnCC7 = false;
  void defineParams(ParamBuilder& b) override {
    swell = b.add("swell").range(0, 100).def(0).cc(11).cc(4);
    vol = b.add("vol").range(0, 150).def(100).cc(7, 0, 100);
    step = b.add("step").range(0, 4).integer().def(0);
  }
  std::unique_ptr<Voice> makeVoice() override { return std::make_unique<MsgVoice>(); }
  void prepare(const PrepareInfo&) override { ccSeen.reserve(64); }
  void processEvents(EventContext& ctx) override {
    for (auto& e : ctx.in()) {
      if (e.type == MidiEvent::Type::CC) {
        ccSeen.push_back(e.cc);
        if (moveOnCC7 && e.cc == 7) ctx.setParam(step, 3);
      }
      ctx.out(e);
    }
  }
};

static MidiEvent ccEvent(int n, float v) { MidiEvent e = CC{n, v, 0}; e.sample = 0; return e; }

TEST(controllers_move_parameters) {
  auto s = std::make_unique<CtlSynth>();
  CtlSynth* syn = s.get();
  Engine eng(std::move(s), testInfo());
  eng.prepare(48000, 128);
  std::vector<float> l(128), r(128);
  float* outs[2] = {l.data(), r.data()};
  HostTransport ht;
  const MidiEvent evs[2] = {ccEvent(11, 1.f), ccEvent(7, 0.5f)};
  eng.process(outs, 2, 128, evs, 2, ht);
  CHECK_NEAR(eng.params().get(syn->swell.index), 100, 1e-3);   // the whole range
  CHECK_NEAR(eng.params().get(syn->vol.index), 50, 1e-3);      // cc(7, 0, 100): half way is 50, not 75
  CHECK(syn->ccSeen.size() == 2);                              // the synth still sees them
  int i = -1, n = 0;
  bool sawSwell = false, sawVol = false;
  while (eng.takeParamChange(i)) { ++n; sawSwell |= i == syn->swell.index; sawVol |= i == syn->vol.index; }
  CHECK(n == 2 && sawSwell && sawVol);
  // A second controller on the same parameter, and nothing queued when nothing moves.
  const MidiEvent cc4 = ccEvent(4, 0.f);
  eng.process(outs, 2, 128, &cc4, 1, ht);
  CHECK_NEAR(eng.params().get(syn->swell.index), 0, 1e-3);
  eng.process(outs, 2, 128, &cc4, 1, ht);
  n = 0;
  while (eng.takeParamChange(i)) ++n;
  CHECK(n == 1);
  // ctx.setParam: a synth's own mapping, in effect at once and queued the same way.
  syn->moveOnCC7 = true;
  const MidiEvent cc7 = ccEvent(7, 1.f);
  eng.process(outs, 2, 128, &cc7, 1, ht);
  CHECK_NEAR(eng.params().get(syn->step.index), 3, 1e-6);
  bool sawStep = false;
  while (eng.takeParamChange(i)) sawStep |= i == syn->step.index;
  CHECK(sawStep);
}

// A mapped controller moves its parameter at the CC's own sample, so the
// host's block size doesn't change when it's heard.
struct LevelVoice : Voice {
  Param level;
  explicit LevelVoice(Param p) : level(p) {}
  void start(const NoteOn&, const StartInfo&) override {}
  void render(VoiceContext& ctx, Buffer& out) override {
    for (int i = 0; i < out.frames; ++i) out.add(i, ctx.get(level));
  }
};
struct LevelSynth : Synth {
  Param level, transpose;
  void defineParams(ParamBuilder& b) override {
    level = b.add("level").range(0, 1).def(0.1).smoothing(0).cc(1, 0.1, 0.4);
    transpose = b.add("transpose").range(-12, 12).integer().def(0).cc(2);
  }
  std::unique_ptr<Voice> makeVoice() override { return std::make_unique<LevelVoice>(level); }
  double lastTuned = 0;
  double tune(int note, const NoteContext& n) override { return lastTuned = note + n.get(transpose); }
};

TEST(controllers_move_parameters_at_their_sample) {
  auto render = [](int block) {
    Engine eng(std::make_unique<LevelSynth>(), testInfo());
    eng.prepare(48000, block);
    HostTransport ht;
    std::vector<float> out, l(static_cast<std::size_t>(block)), r(static_cast<std::size_t>(block));
    for (long pos = 0; pos < 8192; pos += block) {
      std::vector<MidiEvent> ev;
      if (pos == 0) { MidiEvent e = on(60); e.sample = 0; ev.push_back(e); }
      if (3000 >= pos && 3000 < pos + block) { MidiEvent e = ccEvent(1, 1.f); e.sample = static_cast<int>(3000 - pos); ev.push_back(e); }
      float* o[2] = {l.data(), r.data()};
      eng.process(o, 2, block, ev.data(), static_cast<int>(ev.size()), ht);
      out.insert(out.end(), l.begin(), l.end());
    }
    return out;
  };
  auto first = [](const std::vector<float>& x) {
    for (std::size_t i = 0; i < x.size(); ++i) if (x[i] > 0.15f) return static_cast<long>(i);
    return -1L;
  };
  auto a = render(4096), b = render(64), c = render(37 * 8);
  CHECK(first(a) == first(b) && first(a) == first(c));
  CHECK(first(a) >= 3000 && first(a) < 3000 + 64);
  double worst = 0;
  for (std::size_t i = 0; i < 8192; ++i) worst = std::max({worst, static_cast<double>(std::fabs(a[i] - b[i])), static_cast<double>(std::fabs(a[i] - c[i]))});
  CHECK(worst < 1e-6);
}

TEST(tune_reads_parameters) {
  auto s = std::make_unique<LevelSynth>();
  LevelSynth* syn = s.get();
  Engine eng(std::move(s), testInfo());
  eng.prepare(48000, 128);
  std::vector<float> l(128), r(128);
  float* o[2] = {l.data(), r.data()};
  HostTransport ht;
  eng.params().set(syn->transpose.index, 5);
  MidiEvent n1 = on(60);
  n1.sample = 0;
  eng.process(o, 2, 128, &n1, 1, ht);
  CHECK_NEAR(syn->lastTuned, 65, 1e-6);
  // A controller and a note on the same sample: the note hears the moved value.
  MidiEvent evs[2] = {ccEvent(2, 0.f), on(62)};
  evs[1].sample = 40;
  evs[0].sample = 40;
  eng.process(o, 2, 128, evs, 2, ht);
  CHECK_NEAR(syn->lastTuned, 50, 1e-6);
}

TEST(controllers_are_checked) {
  struct Bad : CtlSynth {
    void defineParams(ParamBuilder& b) override { b.add("x").cc(123); }
  };
  CHECK_THROWS(Engine(std::make_unique<Bad>(), testInfo()));
}

TEST(all_notes_off_and_panic_reach_process_events) {
  auto s = std::make_unique<CtlSynth>();
  CtlSynth* syn = s.get();
  Engine eng(std::move(s), testInfo());
  eng.prepare(48000, 128);
  std::vector<float> l(128), r(128);
  float* outs[2] = {l.data(), r.data()};
  HostTransport ht;
  eng.allNotesOff();
  eng.process(outs, 2, 128, nullptr, 0, ht);
  eng.panic();
  eng.process(outs, 2, 128, nullptr, 0, ht);
  eng.process(outs, 2, 128, nullptr, 0, ht);   // once each
  CHECK(syn->ccSeen.size() == 2 && syn->ccSeen[0] == 123 && syn->ccSeen[1] == 120);
}

TEST(tempo_source_and_tempo_in_patches) {
  SynthInfo info = testInfo();
  info.features.tempoInPatch = true;
  Engine eng(std::make_unique<CtlSynth>(), info);
  eng.prepare(48000, 128);
  std::vector<float> l(128), r(128);
  float* outs[2] = {l.data(), r.data()};
  double bpm = 0;
  int num = 0, den = 0;
  CHECK(!eng.patchTempo(bpm, num, den));
  CHECK(!eng.savePatch().contains("tempo"));
  // Saved and loaded with the patch.
  eng.setPatchTempo(74, 6, 8);
  Json p = eng.savePatch();
  CHECK(p["tempo"]["bpm"].number() == 74 && p["tempo"]["timeSig"][0].number() == 6 && p["tempo"]["timeSig"][1].number() == 8);
  Engine other(std::make_unique<CtlSynth>(), info);
  CHECK(other.loadPatch(p).ok);
  CHECK(other.patchTempo(bpm, num, den) && bpm == 74 && num == 6 && den == 8);
  // With no tempo information, the kit's clock runs at the patch's tempo.
  HostTransport none;
  eng.process(outs, 2, 128, nullptr, 0, none);
  CHECK(eng.transport().source == TempoSource::Own && eng.transport().bpm == 74 && eng.transport().timeSigNum == 6);
  // A DAW's tempo wins, and says where it came from.
  HostTransport daw;
  daw.valid = true;
  daw.bpm = 128;
  daw.source = TempoSource::Daw;
  eng.process(outs, 2, 128, nullptr, 0, daw);
  CHECK(eng.transport().source == TempoSource::Daw && eng.transport().bpm == 128);
  // A patch without a tempo clears it.
  Json q = eng.savePatch();
  q.erase("tempo");
  CHECK(eng.loadPatch(q).ok && !eng.patchTempo(bpm, num, den));
  // Synths without the feature carry a patch's tempo through unchanged.
  Engine plain(std::make_unique<CtlSynth>(), testInfo());
  CHECK(plain.loadPatch(p).ok);
  CHECK(plain.savePatch()["tempo"]["bpm"].number() == 74);
}

// ------------------------------------------------------------ sk::wa blocks
// (Bit-level agreement with the browser is checked by
// web/test/webaudio-parity.cjs; these check the blocks on their own.)

TEST(wa_convolver_is_exact_convolution) {
  // Long enough to use every partition size, with odd lengths.
  dsp::Rng rng(7);
  const int irLen = 20000, n = 30000;
  std::vector<float> ir(irLen), x(n);
  for (auto& v : ir) v = rng.bipolar() * 0.01f;
  for (auto& v : x) v = rng.bipolar();
  const float* chans[1] = {ir.data()};
  wa::Convolver c;
  c.setImpulse(chans, 1, irLen, 48000, false);
  double worst = 0;
  for (int i = 0; i < n; ++i) {
    float l = x[i], r = x[i];
    c.process(l, r);
    if (i % 997 == 0 || i == n - 1) {
      double ref = 0;
      for (int k = 0; k < irLen && k <= i; ++k) ref += static_cast<double>(ir[k]) * x[i - k];
      worst = std::max(worst, std::fabs(ref - l));
      CHECK(l == r);
    }
  }
  CHECK(worst < 1e-4);
}

TEST(wa_convolver_normalises_like_web_audio) {
  // A single-sample response of height h has RMS power h/sqrt(len); the
  // normalised gain is 1/power * 10^(-58/20) * 44100/sampleRate.
  std::vector<float> ir(100, 0.f);
  ir[0] = 0.5f;
  const float* chans[1] = {ir.data()};
  wa::Convolver c;
  c.setImpulse(chans, 1, 100, 44100, true);
  float l = 1, r = 1;
  c.process(l, r);
  const double power = 0.5 / std::sqrt(100.0);
  CHECK_NEAR(l, 0.5 / power * std::pow(10.0, -58.0 / 20), 1e-5);
}

TEST(wa_biquad_responses) {
  wa::BiquadFilter f;
  f.prepare(48000);
  f.set(1000, 0);  // lowpass; Q is in dB here, and Q = 0 dB gives 0 dB at the corner
  CHECK_NEAR(20 * std::log10(f.magnitude(1000)), 0.0, 0.05);
  CHECK(f.magnitude(10) > 0.99 && f.magnitude(10000) < 0.05);
  f.setType(wa::BiquadFilter::Type::Peaking);
  f.set(2000, 2, 6);
  CHECK_NEAR(20 * std::log10(f.magnitude(2000)), 6.0, 0.01);
  f.setType(wa::BiquadFilter::Type::Highshelf);
  f.set(3000, 1, -9);
  CHECK_NEAR(20 * std::log10(f.magnitude(20000)), -9.0, 0.3);
  f.setType(wa::BiquadFilter::Type::Notch);
  f.set(440, 4);
  CHECK(f.magnitude(440) < 1e-6);
  // Detune shifts the frequency: +1200 cents is an octave.
  f.setType(wa::BiquadFilter::Type::Peaking);
  f.set(1000, 3, 12, 1200);
  CHECK_NEAR(20 * std::log10(f.magnitude(2000)), 12.0, 0.01);
}

TEST(wa_compressor_reduces_loud_and_passes_quiet) {
  wa::DynamicsCompressor c;
  c.prepare(48000);
  c.set(-24, 30, 12, 0.003f, 0.25f);
  CHECK(c.latency() == 288);
  float l = 0, r = 0;
  for (int i = 0; i < 48000; ++i) { l = r = (i % 2 ? 0.9f : -0.9f); c.process(l, r); }
  CHECK(c.reduction() < -3);
  CHECK(std::isfinite(l) && std::fabs(l) < 0.9f);
  for (int i = 0; i < 96000; ++i) { l = r = (i % 2 ? 0.001f : -0.001f); c.process(l, r); }
  CHECK(c.reduction() > -1);
}

TEST(wa_oscillator_pitch_and_level) {
  wa::PeriodicWave w;
  w.build(48000, wa::PeriodicWave::Basic::Sine);
  wa::Oscillator o;
  o.prepare(48000);
  o.setWave(&w);
  int up = 0;
  float prev = 0, peak = 0;
  for (int i = 0; i < 48000; ++i) {
    const float v = o.next(441);
    if (prev <= 0 && v > 0) ++up;
    prev = v;
    peak = std::max(peak, std::fabs(v));
  }
  CHECK(up >= 440 && up <= 442);
  CHECK_NEAR(peak, 1.0, 1e-3);
  // Without normalisation, imag = [0, 0.5] is a sine of amplitude 0.5.
  const float re[2] = {0, 0}, im[2] = {0, 0.5f};
  w.build(48000, re, im, 2, true);
  o.reset();
  peak = 0;
  for (int i = 0; i < 4800; ++i) peak = std::max(peak, std::fabs(o.next(100)));
  CHECK_NEAR(peak, 0.5, 1e-3);
}

TEST(wa_shaper_curve_and_oversampling_latency) {
  wa::WaveShaper s;
  const float curve[3] = {-1, 0, 1};
  s.setCurve(curve, 3);
  CHECK_NEAR(s.shape(0.5f), 0.5, 1e-6);
  CHECK_NEAR(s.shape(2.f), 1.0, 1e-6);
  for (auto [os, latency] : {std::pair{wa::WaveShaper::Oversample::X2, 128}, std::pair{wa::WaveShaper::Oversample::X4, 192}}) {
    s.setOversample(os);
    int at = -1;
    float peak = 0;
    for (int i = 0; i < 1024; ++i) {
      const float v = std::fabs(s.process(i == 0 ? 0.5f : 0.f));
      if (v > peak) { peak = v; at = i; }
    }
    CHECK(at == latency);
    CHECK_NEAR(peak, 0.496, 0.001);
  }
}

TEST(wa_param_automation) {
  wa::Param p(0);
  CHECK(p.setValueAtTime(1, 0.1));
  CHECK(p.linearRampToValueAtTime(3, 0.2));
  CHECK(p.exponentialRampToValueAtTime(0.03f, 0.3));
  CHECK(p.setTargetAtTime(1, 0.4, 0.05));
  const float curve[3] = {0, 1, 0};
  CHECK(p.setValueCurveAtTime(curve, 3, 0.6, 0.2));
  CHECK(!p.setValueAtTime(5, 0.65));   // inside the curve: refused
  CHECK(!p.exponentialRampToValueAtTime(0, 1));
  CHECK_NEAR(p.valueAt(0.05), 0, 1e-6);
  CHECK_NEAR(p.valueAt(0.15), 2, 1e-5);
  CHECK_NEAR(p.valueAt(0.25), 0.3, 1e-4);           // halfway, geometrically: sqrt(3 * 0.03)
  CHECK_NEAR(p.valueAt(0.45), 1 + (0.03 - 1) * std::exp(-1.0), 1e-4);
  CHECK_NEAR(p.valueAt(0.7), 1, 1e-5);
  CHECK_NEAR(p.valueAt(0.75), 0.5, 1e-5);
  CHECK_NEAR(p.valueAt(2), 0, 1e-6);                 // holds the curve's last value
  // cancelAndHold in the middle of a ramp freezes it there.
  wa::Param q(0);
  q.linearRampToValueAtTime(1, 1);
  q.cancelAndHoldAtTime(0.25);
  CHECK_NEAR(q.valueAt(0.1), 0.1, 1e-5);
  CHECK_NEAR(q.valueAt(0.9), 0.25, 1e-5);
  // Range clamping.
  wa::Param r(0, 0, 1);
  r.setValueAtTime(4, 0);
  CHECK_NEAR(r.valueAt(0.1), 1, 1e-6);
}

TEST(wa_panner_and_delay) {
  float l = 1, r = 0;
  wa::StereoPanner::process(1, l, r);   // hard right: left moves into right
  CHECK_NEAR(l, 0, 1e-6);
  CHECK_NEAR(r, 1, 1e-6);
  wa::StereoPanner::processMono(0, 1, l, r);
  CHECK_NEAR(l, std::sqrt(0.5), 1e-6);
  CHECK_NEAR(r, std::sqrt(0.5), 1e-6);
  wa::Delay d;
  d.prepare(48000, 0.1);
  float out = 0;
  for (int i = 0; i < 20; ++i) {
    const float y = d.process(i == 0 ? 1.f : 0.f, 10.5 / 48000);
    if (i == 10) out = y;
    if (i == 11) CHECK_NEAR(y, 0.5, 1e-3);
  }
  CHECK_NEAR(out, 0.5, 1e-3);
}

// ------------------------------------------------------------ arpeggiator

static const char* kArp = R"(,"arp":true,"modSlots":4)";

static void arpOn(Harness& h, std::initializer_list<std::pair<const char*, double>> ps = {}) {
  auto& p = h.eng->params();
  p.set(h.param("arp.on"), 1);
  p.set(h.param("env1.release"), 0.002);
  p.set(h.param("arp.release"), 0.002);
  for (auto& [id, v] : ps) p.set(h.param(id), v);
}

static std::vector<int> startedNotes() {
  std::vector<int> n;
  for (auto& s : gLog.starts) n.push_back(s.note);
  return n;
}

TEST(arp_plays_up_on_the_grid) {
  Harness h(256, kArp);
  arpOn(h);   // 1/16 at 120 bpm: a step every 6000 samples
  h.run(24000, {{0, on(60)}, {10, on(64)}, {20, on(67)}});
  auto n = startedNotes();
  CHECK((n == std::vector<int>{60, 64, 67, 60}));
  for (std::size_t i = 0; i < gLog.starts.size(); ++i) {
    CHECK(gLog.starts[i].arp);
    CHECK_NEAR(gLog.starts[i].beat, 0.25 * static_cast<double>(i), 1.0 / 24000);
  }
}

TEST(arp_modes_and_octaves) {
  auto play = [](double mode, double oct, long steps) {
    Harness h(256, kArp);
    arpOn(h, {{"arp.mode", mode}, {"arp.octaves", oct}});
    h.run(steps * 6000 - 100, {{0, on(64)}, {0, on(60)}, {0, on(67)}});
    return startedNotes();
  };
  CHECK((play(1, 1, 4) == std::vector<int>{67, 64, 60, 67}));                  // Down
  CHECK((play(2, 1, 6) == std::vector<int>{60, 64, 67, 64, 60, 64}));          // Up/Down
  CHECK((play(3, 1, 6) == std::vector<int>{67, 64, 60, 64, 67, 64}));          // Down/Up
  CHECK((play(0, 2, 7) == std::vector<int>{60, 64, 67, 72, 76, 79, 60}));      // Up, 2 octaves
  CHECK((play(4, 1, 4) == std::vector<int>{64, 60, 67, 64}));                  // As Played
  auto chord = play(6, 2, 2);                                                   // Chord, 2 octaves
  std::sort(chord.begin(), chord.begin() + std::min<std::ptrdiff_t>(3, static_cast<std::ptrdiff_t>(chord.size())));
  CHECK((chord.size() == 6 && std::vector<int>(chord.begin(), chord.begin() + 3) == std::vector<int>{60, 64, 67}));
  auto rnd = play(5, 1, 32);
  CHECK(rnd.size() == 32);
  for (std::size_t i = 1; i < rnd.size(); ++i) CHECK(rnd[i] != rnd[i - 1]);   // no immediate repeats
}

TEST(arp_grid_and_key_sync) {
  {
    // 0.4 beats in: too late for the 0.25 grid point, so it waits for 0.5.
    Harness h(256, kArp);
    arpOn(h);
    h.run(24000, {{9600, on(60)}});
    CHECK(!gLog.starts.empty());
    if (!gLog.starts.empty()) CHECK_NEAR(gLog.starts[0].beat, 0.5, 1.0 / 24000);
  }
  {
    // Just after a grid point (25 ms): plays at once.
    Harness h(256, kArp);
    arpOn(h);
    h.run(24000, {{7200, on(60)}});
    CHECK(!gLog.starts.empty());
    if (gLog.starts.size() > 1) { CHECK_NEAR(gLog.starts[0].beat, 0.3, 1.0 / 24000); CHECK_NEAR(gLog.starts[1].beat, 0.5, 1.0 / 24000); }
  }
  {
    Harness h(256, kArp);
    arpOn(h, {{"arp.sync", 1}});   // Key: steps count from the key
    h.run(24000, {{9600, on(60)}});
    CHECK(gLog.starts.size() >= 2);
    if (gLog.starts.size() >= 2) { CHECK_NEAR(gLog.starts[0].beat, 0.4, 1.0 / 24000); CHECK_NEAR(gLog.starts[1].beat, 0.65, 1.0 / 24000); }
  }
}

TEST(arp_swing_delays_every_other_step) {
  Harness h(256, kArp);
  arpOn(h, {{"arp.swing", 100}});   // odd steps a third of a step late
  h.run(24000, {{0, on(60)}});
  CHECK(gLog.starts.size() >= 3);
  if (gLog.starts.size() >= 3) {
    CHECK_NEAR(gLog.starts[1].beat, 0.25 + 0.25 / 3, 1.0 / 24000);
    CHECK_NEAR(gLog.starts[2].beat, 0.5, 1.0 / 24000);
  }
}

TEST(arp_gate_sets_note_length) {
  Harness h(256, kArp);
  arpOn(h, {{"arp.gate", 50}});
  h.run(2400, {{0, on(60)}});                    // beat 0.05: playing
  CHECK(h.eng->takeStats().activeVoices == 1);
  h.run(2400 * 3);                               // beat 0.2: step 0 ended at 0.125
  CHECK(h.eng->takeStats().activeVoices == 0);
}

TEST(arp_latch_and_new_phrase) {
  Harness h(256, kArp);
  arpOn(h, {{"arp.latch", 1}});
  h.run(12000, {{0, on(60)}, {1, on(64)}, {6000 - 100, off(60)}, {6000 - 99, off(64)}});
  gLog.starts.clear();
  h.run(24000);                                   // keys up: still playing
  CHECK(gLog.starts.size() == 4);
  gLog.starts.clear();
  h.run(12000, {{h.pos, on(72)}});                // a new phrase replaces the chord
  for (auto& s : gLog.starts) CHECK(s.note == 72);
  CHECK(!gLog.starts.empty());
  h.eng->allNotesOff();                           // the kit's all notes off lets go of a latched chord
  h.run(6000);
  gLog.starts.clear();
  h.run(24000);
  CHECK(gLog.starts.empty());
}

TEST(arp_phrase_tail_and_stop) {
  auto stepsAfterRelease = [](double release) {
    Harness h(256, kArp);
    arpOn(h, {{"arp.phraseRelease", release}});
    h.run(12000, {{0, on(60)}, {1, on(64)}, {11000, off(60)}, {11010, off(64)}});
    gLog.starts.clear();
    h.run(96000);
    return startedNotes();
  };
  CHECK(stepsAfterRelease(0.002).empty());         // stops at once
  auto tail = stepsAfterRelease(1.0);              // plays on while it fades
  CHECK(tail.size() > 4);
  // Both keys belong to the tail, though one was let go of first.
  CHECK(std::count(tail.begin(), tail.end(), 60) > 0 && std::count(tail.begin(), tail.end(), 64) > 0);
}

static double rms(const std::vector<float>& v, std::size_t a, std::size_t b) {
  double s = 0;
  for (std::size_t i = a; i < b && i < v.size(); ++i) s += static_cast<double>(v[i]) * v[i];
  return std::sqrt(s / static_cast<double>(std::max<std::size_t>(1, b - a)));
}

TEST(arp_phrase_envelope_shapes_only_arp_notes) {
  Harness h(256, kArp);
  arpOn(h, {{"arp.phraseAttack", 2.0}, {"arp.gate", 100}});
  auto out = h.run(96000, {{0, on(60)}});
  CHECK(rms(out, 1000, 5000) < 0.25 * rms(out, 90000, 95000));   // fading in over 2 s
  // With the arp off, the phrase envelope doesn't touch played notes.
  Harness k(256, kArp);
  k.eng->params().set(k.param("arp.phraseAttack"), 2.0);
  auto played = k.run(24000, {{0, on(60)}});
  CHECK(rms(played, 2000, 6000) > 0.1);
}

TEST(arp_envelope_multiply_or_replace) {
  auto level = [](double mode) {
    Harness h(256, kArp);
    arpOn(h, {{"arp.envMode", mode}, {"env1.attack", 5.0}, {"arp.gate", 100}});
    auto out = h.run(24000, {{0, on(60)}});
    return rms(out, 12000, 24000);
  };
  double off = level(0), mul = level(1), rep = level(2);
  CHECK(rep > 5 * mul);       // Replace ignores env1's slow attack
  CHECK(mul < 2 * off);       // Multiply keeps it
  CHECK(rep > 0.1);
}

TEST(arp_notes_ignore_the_pedal_but_keys_stay) {
  Harness h(256, kArp);
  arpOn(h);
  MidiEvent ped = CC{64, 1.f}, up = CC{64, 0.f};
  h.run(12000, {{0, ped}, {10, on(60)}, {100, off(60)}});
  gLog.starts.clear();
  h.run(24000);
  CHECK(gLog.starts.size() == 4);                         // pedal keeps the key in the chord
  CHECK(h.eng->takeStats().activeVoices <= 1);            // but arp notes still end
  h.run(12000, {{h.pos + 10, up}});
  gLog.starts.clear();
  h.run(24000);
  CHECK(gLog.starts.empty());
}

TEST(arp_off_passes_keys_and_hands_back_held_ones) {
  Harness h(256, kArp);
  h.run(4800, {{0, on(60)}});
  CHECK(gLog.starts.size() == 1 && !gLog.starts[0].arp);
  Harness k(256, kArp);
  arpOn(k);
  k.run(12000, {{0, on(60)}});
  k.eng->params().set(k.param("arp.on"), 0);
  gLog.starts.clear();
  k.run(24000);
  CHECK(gLog.starts.size() == 1);                         // the held key now sounds as played
  if (!gLog.starts.empty()) CHECK(!gLog.starts[0].arp && gLog.starts[0].note == 60);
  k.run(4800, {{k.pos + 10, off(60)}});
  k.run(4800);
  CHECK(k.eng->takeStats().activeVoices == 0);
}

TEST(arp_mono_mode) {
  Harness h(256, kArp);
  arpOn(h, {{"voiceMode", 1}, {"arp.gate", 150}});
  h.run(24000, {{0, on(60)}, {1, on(64)}});
  CHECK(h.eng->takeStats().activeVoices == 1);
  CHECK(gLog.starts.size() >= 4);
}

TEST(arp_block_size_does_not_change_output) {
  auto render = [](int block) {
    Harness h(block, kArp);
    arpOn(h, {{"arp.swing", 40}, {"arp.mode", 2}, {"arp.octaves", 2}, {"arp.phraseRelease", 0.3}, {"arp.decay", 0.05}, {"arp.sustain", 0.3}});
    h.run(24000, {}, block);   // let the parameters settle
    const long p = h.pos;
    return h.run(48000, {{p + 100, on(60)}, {p + 5000, on(67)}, {p + 7000, on(63)}, {p + 20000, off(60)}, {p + 20000, off(63)}, {p + 20003, off(67)}}, block);
  };
  auto a = render(256), b = render(7), c = render(1000), d = render(1);
  double worst = 0;
  for (std::size_t i = 0; i < a.size(); ++i)
    worst = std::max({worst, static_cast<double>(std::fabs(a[i] - b[i])), static_cast<double>(std::fabs(a[i] - c[i])), static_cast<double>(std::fabs(a[i] - d[i]))});
  CHECK(worst < 1e-5);
}

TEST(arp_follows_a_transport_jump) {
  Harness h(256, kArp);
  arpOn(h, {{"arp.gate", 90}});
  h.ht.playing = true;
  h.run(9000, {{0, on(60)}, {0, on(64)}});
  h.pos = 96000 + 1000;                     // the host loops to just after beat 4
  gLog.starts.clear();
  h.run(12000);
  CHECK(!gLog.starts.empty());
  // Back on the song's grid: the next sixteenth after the jump.
  if (!gLog.starts.empty()) CHECK_NEAR(gLog.starts[0].beat, 4.25, 1.0 / 24000);
  CHECK(h.eng->takeStats().droppedEvents == 0);
}

TEST(arp_pattern_rows_are_chord_tones) {
  Harness h(256, kArp);
  arpOn(h, {{"arp.mode", 7}, {"arp.pattern", 2}, {"arp.gate", 100}});
  // Pattern 2: rows 0, 3 (past three held notes: the lowest an octave up),
  // -1 (the highest an octave down), a rest, and 1 held for two steps.
  Json bank = h.eng->customState("sk.arp");
  bank["patterns"][1] = Json::parse(R"({"steps":6,"notes":[[0,0,1,100],[1,3,1,100],[2,-1,1,64],[4,1,2,100]]})");
  CHECK(h.eng->setCustomState("sk.arp", bank));
  h.run(36100, {{0, on(60)}, {0, on(64)}, {0, on(67)}});
  auto n = startedNotes();
  CHECK((n == std::vector<int>{60, 72, 55, 64, 60}));
  if (gLog.starts.size() == 5) {
    CHECK_NEAR(gLog.starts[3].beat, 1.0, 1.0 / 24000);   // step 4 (a rest at step 3)
    CHECK_NEAR(gLog.starts[4].beat, 1.5, 1.0 / 24000);   // the pattern repeats after 6 steps
  }
  // The two-step note is still held a step and a half later.
  Harness k(256, kArp);
  arpOn(k, {{"arp.mode", 7}, {"arp.pattern", 2}, {"arp.gate", 100}});
  CHECK(k.eng->setCustomState("sk.arp", bank));
  k.run(6000 * 4 + 9000, {{0, on(60)}, {0, on(64)}, {0, on(67)}});
  CHECK(k.eng->takeStats().activeVoices == 1);
}

TEST(arp_pattern_chance_and_round_trip) {
  Harness h(256, kArp);
  arpOn(h, {{"arp.mode", 7}, {"arp.pattern", 3}});
  Json bank = h.eng->customState("sk.arp");
  bank["patterns"][2] = Json::parse(R"({"steps":1,"notes":[[0,0,1,100,50]]})");
  CHECK(h.eng->setCustomState("sk.arp", bank));
  h.run(6000 * 200, {{0, on(60)}});
  CHECK(gLog.starts.size() > 60 && gLog.starts.size() < 140);   // about half the steps
  Json saved = h.eng->savePatch();
  CHECK(saved["custom"]["sk.arp"]["patterns"][2]["notes"][0][4].number() == 50);
  Harness k(256, kArp);
  CHECK(k.eng->loadPatch(saved).ok);
  CHECK(k.eng->savePatch() == saved);
  // Default bank: pattern 1 plays out of the box.
  Harness d(256, kArp);
  arpOn(d, {{"arp.mode", 7}});
  d.run(6000 * 8, {{0, on(60)}, {0, on(64)}, {0, on(67)}});
  CHECK(gLog.starts.size() == 8);
}

TEST(arp_without_a_matrix) {
  Harness h(256, R"(,"arp":true)");
  arpOn(h, {{"arp.mode", 7}});
  h.run(6000 * 8, {{0, on(60)}, {0, on(64)}, {0, on(67)}});
  CHECK(gLog.starts.size() == 8);
  // Meters still carry the arpeggiator's sources (the piano roll's playhead).
  std::vector<float> src(h.eng->modSources().size()), prm(static_cast<std::size_t>(h.eng->params().size())), shp(1);
  h.eng->readModMeters(src.data(), prm.data(), shp.data());
  bool found = false;
  for (std::size_t i = 0; i < src.size(); ++i)
    if (h.eng->modSources()[i].id == "arp.phrase") { found = true; CHECK(src[i] > 0.5f); }
  CHECK(found);
}

static Json gen(double density, double leaps, double repetition, int seed, int steps = 16, int range = 5) {
  Json s = Json::object();
  s["steps"] = steps; s["density"] = density; s["leaps"] = leaps; s["repetition"] = repetition; s["seed"] = seed; s["range"] = range;
  return arpGeneratePattern(s);
}

TEST(arp_generator_is_seeded_and_bounded) {
  CHECK(gen(0.5, 0.3, 0.6, 7) == gen(0.5, 0.3, 0.6, 7));
  int differ = 0;
  for (int seed = 1; seed < 20; ++seed) differ += !(gen(0.5, 0.3, 0.6, seed) == gen(0.5, 0.3, 0.6, seed + 100));
  CHECK(differ >= 17);
  for (int seed = 1; seed < 200; ++seed) {
    Json p = gen(seed % 10 / 9.0, seed % 7 / 6.0, seed % 5 / 4.0, seed, 4 + seed % 61, 2 + seed % 9);
    const int steps = static_cast<int>(p["steps"].number());
    bool downbeat = false;
    for (auto& n : p["notes"].items()) {
      const int st = static_cast<int>(n[0].number()), row = static_cast<int>(n[1].number()), len = static_cast<int>(n[2].number());
      CHECK(st >= 0 && st < steps && len >= 1 && st + len <= steps);
      CHECK(row >= 0 && row <= 2 + seed % 9 + 1);   // within the range (double stops two rows up)
      downbeat |= st == 0 && row == 0;
    }
    CHECK(downbeat);   // every pattern starts on the first chord tone, on the downbeat
  }
}

TEST(arp_generator_is_musical) {
  // Over many seeds: strong steps play more often than weak ones; density
  // adds notes; leaps make bigger jumps; more repetition repeats the motif.
  double strong = 0, weak = 0, nLow = 0, nHigh = 0, leapSmall = 0, leapBig = 0, repLow = 0, repHigh = 0;
  auto onsets = [](const Json& p) { std::vector<std::vector<int>> at(16); for (auto& n : p["notes"].items()) at[static_cast<std::size_t>(n[0].number())].push_back(static_cast<int>(n[1].number())); return at; };
  auto bigJumps = [](const Json& p) {
    int prev = -999, big = 0, all = 0;
    for (auto& n : p["notes"].items()) { int r = static_cast<int>(n[1].number()); if (prev != -999) { ++all; big += std::abs(r - prev) >= 2; } prev = r; }
    return all ? static_cast<double>(big) / all : 0.0;
  };
  for (int seed = 1; seed <= 300; ++seed) {
    auto at = onsets(gen(0.5, 0.3, 0.6, seed));
    for (int st = 0; st < 16; ++st) (st % 4 == 0 ? strong : weak) += at[static_cast<std::size_t>(st)].empty() ? 0 : (st % 4 == 0 ? 1.0 / 4 : 1.0 / 12);
    nLow += gen(0.2, 0.3, 0.6, seed)["notes"].size();
    nHigh += gen(0.9, 0.3, 0.6, seed)["notes"].size();
    leapSmall += bigJumps(gen(0.6, 0.0, 0.6, seed, 16, 8));
    leapBig += bigJumps(gen(0.6, 1.0, 0.6, seed, 16, 8));
    for (double rep : {0.0, 1.0}) {
      Json p = gen(0.6, 0.3, rep, seed);
      auto a = onsets(p);
      int same = 0;
      for (int o = 0; o < 4; ++o) same += a[static_cast<std::size_t>(o)] == a[static_cast<std::size_t>(o + 4)];
      (rep > 0.5 ? repHigh : repLow) += same;
    }
  }
  CHECK(strong > 1.4 * weak);
  CHECK(nHigh > 1.8 * nLow);
  CHECK(leapBig > leapSmall + 0.15);
  CHECK(repHigh > 1.3 * repLow);
}

TEST(arp_evolve_varies_but_stays_close) {
  auto cycles = [](double evolve) {
    Harness h(256, kArp);
    arpOn(h, {{"arp.mode", 7}, {"arp.evolve", evolve}, {"arp.gate", 40}});
    Json bank = h.eng->customState("sk.arp");
    bank["patterns"][0] = gen(0.8, 0.3, 0.6, 11, 8);
    CHECK(h.eng->setCustomState("sk.arp", bank));
    h.run(6000 * 8 * 12, {{0, on(60)}, {0, on(64)}, {0, on(67)}});
    std::vector<std::vector<int>> per(12);
    for (auto& s : gLog.starts) per[static_cast<std::size_t>(std::min(11.0, std::floor(s.beat / 2.0 + 1e-6)))].push_back(s.note);
    return per;
  };
  auto still = cycles(0);
  for (auto& c : still) CHECK(c == still[0]);
  auto moving = cycles(100);
  CHECK(moving[0] == still[0]);            // the first time round is as drawn
  int changed = 0;
  for (std::size_t i = 1; i < moving.size(); ++i) changed += moving[i] != still[0];
  CHECK(changed >= 6);
  // Recognisable: each cycle still shares most of its notes with the original.
  for (auto& c : moving) {
    std::vector<int> x = c, y = still[0], both;
    std::sort(x.begin(), x.end()); std::sort(y.begin(), y.end());
    std::set_intersection(x.begin(), x.end(), y.begin(), y.end(), std::back_inserter(both));
    CHECK(both.size() * 2 >= y.size());
  }
  // And it doesn't depend on the block size.
  auto again = [&](int block) {
    Harness h(block, kArp);
    arpOn(h, {{"arp.mode", 7}, {"arp.evolve", 70}});
    Json bank = h.eng->customState("sk.arp");
    bank["patterns"][0] = gen(0.8, 0.3, 0.6, 11, 8);
    h.eng->setCustomState("sk.arp", bank);
    h.run(24000, {}, block);
    const long p0 = h.pos;
    return h.run(6000 * 40, {{p0, on(60)}, {p0, on(64)}, {p0, on(67)}}, block);
  };
  auto a = again(256), b = again(37);
  double worst = 0;
  for (std::size_t i = 0; i < a.size(); ++i) worst = std::max(worst, static_cast<double>(std::fabs(a[i] - b[i])));
  CHECK(worst < 1e-5);
}

// ------------------------------------------------------------ sequencer

static void seqOn(Harness& h, std::initializer_list<std::pair<const char*, double>> ps = {}) {
  arpOn(h, ps);
  h.eng->params().set(h.param("arp.on"), 2);
  for (auto& [id, v] : ps) h.eng->params().set(h.param(id), v);
}

static void seqPattern(Harness& h, const char* json, int slot = 0) {
  Json bank = h.eng->customState("sk.seq");
  bank["patterns"][static_cast<std::size_t>(slot)] = Json::parse(json);
  CHECK(h.eng->setCustomState("sk.seq", bank));
}

struct StartAt { int note; double beat; bool arp; };
static std::vector<StartAt> startsByTime() {
  std::vector<StartAt> v;
  for (auto& s : gLog.starts) v.push_back({s.note, s.beat, s.arp});
  std::stable_sort(v.begin(), v.end(), [](auto& a, auto& b) { return a.beat < b.beat - 1e-9; });
  return v;
}

TEST(seq_each_key_plays_its_own_pattern) {
  Harness h(256, kArp);
  seqOn(h);
  // Default pattern 1: +12 at step 0, +7 at 2, +10 at 4, +7 at 5, +5 at 7 (8 steps of 1/16).
  h.run(12100, {{0, on(60)}, {7200, on(64)}});   // E 0.3 beats later: its own sequence, from its own step 1
  auto v = startsByTime();
  std::vector<std::pair<int, double>> seqNotes;
  int keys = 0;
  for (auto& x : v) { if (x.arp) seqNotes.push_back({x.note, x.beat}); else ++keys; }
  CHECK(keys == 2);                                  // both keys sound as played
  std::vector<std::pair<int, double>> want = {{72, 0.0}, {76, 0.3}, {67, 0.5}};   // C +12, E +12, C +7
  CHECK(seqNotes.size() == want.size());
  for (std::size_t i = 0; i < std::min(want.size(), seqNotes.size()); ++i) {
    CHECK(seqNotes[i].first == want[i].first);
    CHECK_NEAR(seqNotes[i].second, want[i].second, 1.0 / 24000);
  }
  gLog.starts.clear();
  h.run(12000);                                       // to beat 1: E's step 2 (+7) at 0.8, C's step 4 (+10) at 1.0
  auto w = startsByTime();
  CHECK(w.size() == 2);
  if (w.size() == 2) {
    CHECK(w[0].note == 71); CHECK_NEAR(w[0].beat, 0.8, 1.0 / 24000);
    CHECK(w[1].note == 70); CHECK_NEAR(w[1].beat, 1.0, 1.0 / 24000);
  }
}

TEST(seq_scale_steps) {
  // C major: rows are scale steps from each key; row 0 is the key itself.
  CHECK(sk::detail::arpScalePitch(64, 2, 1, 0) == 67);    // E + 2 steps = G
  CHECK(sk::detail::arpScalePitch(64, 4, 1, 0) == 71);    // B
  CHECK(sk::detail::arpScalePitch(64, -1, 1, 0) == 62);   // D
  CHECK(sk::detail::arpScalePitch(64, 7, 1, 0) == 76);    // the octave
  CHECK(sk::detail::arpScalePitch(64, -8, 1, 0) == 50);   // D below the octave down
  CHECK(sk::detail::arpScalePitch(66, 2, 1, 0) == 69);    // F#: counts from F, the scale note below
  CHECK(sk::detail::arpScalePitch(66, 0, 1, 0) == 66);    // but row 0 is the key itself
  CHECK(sk::detail::arpScalePitch(57, 2, 2, 9) == 60);    // A minor: A + 2 = C
  CHECK(sk::detail::arpScalePitch(60, 5, 11, 0) == 72);   // C minor pentatonic: 5 steps = the octave
  CHECK(sk::detail::arpScalePitch(60, 5, 0, 0) == 65);    // chromatic: semitones
  Harness h(256, kArp);
  seqOn(h, {{"arp.scale", 1}, {"arp.scaleKey", 2}});      // D major
  seqPattern(h, R"({"steps":2,"notes":[[0,2,1,100],[1,4,1,100]]})");
  h.run(12000, {{0, on(62)}});                            // D: F# then A
  std::vector<int> seqNotes;
  for (auto& x : startsByTime()) if (x.arp) seqNotes.push_back(x.note);
  CHECK((seqNotes == std::vector<int>{66, 69}));
}

static double rmsDb(const std::vector<float>& v, std::size_t a, std::size_t b) {
  double s = 0;
  for (std::size_t i = a; i < b; ++i) s += static_cast<double>(v[i]) * v[i];
  return 10 * std::log10(s / static_cast<double>(b - a) + 1e-20);
}

TEST(seq_key_and_sequence_levels) {
  auto render = [](double type, double keyDb, double seqDb) {
    Harness h(256, kArp);
    seqOn(h, {{"arp.keyLevel", keyDb}, {"arp.seqLevel", seqDb}});
    h.eng->params().set(h.param("arp.on"), type);
    h.run(24000);
    return h.run(24000, {{h.pos, on(60)}});
  };
  auto plain = render(0, 0, 0), keysOnly = render(2, 0, -60), seqOnly = render(2, -60, 0), quieter = render(2, -6, 0);
  double worst = 0;
  for (std::size_t i = 0; i < plain.size(); ++i) worst = std::max(worst, static_cast<double>(std::fabs(plain[i] - keysOnly[i])));
  CHECK(worst < 1e-6);                                    // sequence at -60 dB: just the key
  CHECK(rmsDb(seqOnly, 0, 2000) > -40);                   // key at -60 dB: the sequence alone (step 0, +12)
  double keyAlone = rmsDb(plain, 6500, 11000), keyQuieter = rmsDb(quieter, 6500, 11000);   // between sequence notes
  CHECK_NEAR(keyQuieter - keyAlone, -6.0, 0.2);
}

TEST(seq_each_key_releases_on_its_own) {
  Harness h(256, kArp);
  seqOn(h, {{"arp.phraseRelease", 1.0}});
  seqPattern(h, R"({"steps":1,"notes":[[0,7,1,100]]})");   // a fifth every step
  h.run(48000, {{0, on(60)}, {12000, on(64)}, {24000, off(60)}});
  gLog.starts.clear();
  h.run(24000);                                            // C let go (tail), E held
  int c = 0, e = 0;
  for (auto& x : gLog.starts) { c += x.note == 67; e += x.note == 71; }
  CHECK(c > 0 && e == 4);                                  // both still playing
  h.run(96000, {{h.pos, off(64)}});
  gLog.starts.clear();
  h.run(24000);
  CHECK(gLog.starts.empty());                              // both tails over
  Harness k(256, kArp);
  seqOn(k, {{"arp.phraseRelease", 0.002}});
  seqPattern(k, R"({"steps":1,"notes":[[0,7,1,100]]})");
  k.run(12000, {{0, on(60)}, {11000, off(60)}});
  gLog.starts.clear();
  k.run(24000);
  CHECK(gLog.starts.empty());                              // no tail: stops with the key
}

TEST(seq_grid_sync_and_latch) {
  Harness h(256, kArp);
  seqOn(h, {{"arp.seqSync", 0}});
  // Grid: E at 0.4 beats joins at 0.5, on the pattern's step 2 (+7).
  h.run(24000, {{9600, on(64)}});
  std::vector<StartAt> s;
  for (auto& x : startsByTime()) if (x.arp) s.push_back(x);
  CHECK(!s.empty());
  if (!s.empty()) { CHECK(s[0].note == 71); CHECK_NEAR(s[0].beat, 0.5, 1.0 / 24000); }
  Harness k(256, kArp);
  seqOn(k, {{"arp.latch", 1}});
  seqPattern(k, R"({"steps":1,"notes":[[0,12,1,100]]})");
  k.run(12000, {{0, on(60)}, {100, off(60)}});
  gLog.starts.clear();
  k.run(24000);
  CHECK(gLog.starts.size() == 4);                          // latched: still going
  k.run(12000, {{k.pos, on(62)}, {k.pos + 100, off(62)}}); // a new phrase lets C's go
  gLog.starts.clear();
  k.run(24000);
  for (auto& x : gLog.starts) CHECK(x.note == 74);
  CHECK(gLog.starts.size() == 4);
}

TEST(seq_crossfade_keeps_the_level_and_joins_repeats) {
  Harness h(256, kArp);
  seqOn(h, {{"arp.envMode", 3}, {"arp.xfade", 100}, {"arp.keyLevel", -60}});
  seqPattern(h, R"({"steps":2,"notes":[[0,7,1,100],[1,12,1,100]]})");
  h.run(24000);
  auto out = h.run(48000, {{h.pos, on(60)}});
  // After the first fade-in, the level stays within 1.5 dB through every crossfade.
  double lo = 1e9, hi = -1e9;
  for (std::size_t a = 6000; a + 1500 <= 42000; a += 750) { double d = rmsDb(out, a, a + 1500); lo = std::min(lo, d); hi = std::max(hi, d); }
  CHECK(hi - lo < 1.5);
  CHECK(h.eng->takeStats().activeVoices <= 3);             // two fading, plus the (silent) key
  // The same pitch twice in a row is one note.
  Harness k(256, kArp);
  seqOn(k, {{"arp.envMode", 3}, {"arp.xfade", 50}});
  seqPattern(k, R"({"steps":4,"notes":[[0,7,1,100],[1,7,1,100],[2,7,1,100],[3,12,1,100]]})");
  k.run(24000, {{0, on(60)}});
  int g = 0;
  for (auto& x : gLog.starts) g += x.note == 67;
  CHECK(g == 1);
}

TEST(seq_many_keys_and_block_size) {
  Harness h(256, kArp);
  seqOn(h);
  std::vector<std::pair<long, MidiEvent>> ev;
  for (int i = 0; i < 24; ++i) ev.push_back({i * 50, on(40 + i)});
  h.run(24000, ev);                                        // more keys than lanes: the oldest are reused
  CHECK(h.eng->takeStats().droppedEvents == 0);
  auto render = [](int block) {
    Harness k(block, kArp);
    seqOn(k, {{"arp.envMode", 3}, {"arp.xfade", 60}, {"arp.scale", 2}, {"arp.swing", 30}, {"arp.phraseRelease", 0.4}, {"arp.evolve", 80}, {"arp.quantize", 1}, {"arp.quantizeTo", 6}});
    k.run(24000, {}, block);
    const long p = k.pos;
    return k.run(96000, {{p + 10, on(57)}, {p + 3000, on(64)}, {p + 30000, off(57)}, {p + 50000, off(64)}, {p + 52000, on(60)}, {p + 70000, off(60)}}, block);
  };
  auto a = render(256), b = render(7), c = render(1000);
  double worst = 0;
  for (std::size_t i = 0; i < a.size(); ++i) worst = std::max({worst, static_cast<double>(std::fabs(a[i] - b[i])), static_cast<double>(std::fabs(a[i] - c[i]))});
  CHECK(worst < 1e-5);
}

TEST(seq_keeps_the_key_in_mono_and_legato) {
  // The keys follow the voice mode; the sequence's notes get voices of their
  // own, so the key (and its glide) carries on under them.
  for (double vm : {1.0, 2.0}) {
    Harness h(256, kArp);
    seqOn(h, {{"voiceMode", vm}, {"arp.gate", 100}});
    seqPattern(h, R"({"steps":1,"notes":[[0,7,1,100]]})");
    h.run(24000, {{0, on(60)}});
    CHECK(h.eng->takeStats().activeVoices == 2);          // the key and the sequence's note
    int keyStarts = 0;
    for (auto& x : gLog.starts) keyStarts += !x.arp;
    CHECK(keyStarts == 1);
    h.run(12000, {{h.pos, on(62)}});                       // a second key: the mono voice moves to it
    CHECK(h.eng->takeStats().activeVoices <= 3);
    h.run(24000, {{h.pos, off(62)}, {h.pos + 10, off(60)}});
    h.run(24000);
    CHECK(h.eng->takeStats().activeVoices == 0);          // nothing left behind
  }
}

TEST(seq_quantize_locks_to_the_nearest_increment) {
  // Rows 1…8 on steps 1…8, so each note says which step played.
  auto run = [](long keySample, double quantizeTo, double beats) {
    Harness h(256, kArp);
    seqOn(h, {{"arp.quantize", 1}, {"arp.quantizeTo", quantizeTo}, {"arp.gate", 40}});
    seqPattern(h, R"({"steps":8,"notes":[[0,1,1,100],[1,2,1,100],[2,3,1,100],[3,4,1,100],[4,5,1,100],[5,6,1,100],[6,7,1,100],[7,8,1,100]]})");
    h.run(static_cast<long>(beats * 24000), {{keySample, on(60)}});
    std::vector<std::pair<int, double>> v;
    for (auto& x : startsByTime()) v.push_back({x.arp ? x.note - 60 : 0, x.beat});
    return v;
  };
  auto check = [](const std::vector<std::pair<int, double>>& got, std::vector<std::pair<int, double>> want) {
    CHECK(got.size() >= want.size());
    for (std::size_t i = 0; i < std::min(got.size(), want.size()); ++i) {
      CHECK(got[i].first == want[i].first);
      CHECK_NEAR(got[i].second, want[i].second, 1.0 / 24000);
    }
  };
  // Quarter notes (a beat). Early (beat 0.8, nearest 1): the key sounds now,
  // step 1 waits for beat 1.
  check(run(19200, 3, 1.6), {{0, 0.8}, {1, 1.0}, {2, 1.25}, {3, 1.5}});
  // Late (1.1, nearest 1): step 1 at once, step 2 back on the grid at 1.25.
  check(run(26400, 3, 1.6), {{0, 1.1}, {1, 1.1}, {2, 1.25}, {3, 1.5}});
  // Very late with a whole-note grid (1.6, nearest 0): step 1 at once, then
  // the timeline from beat 0 picks up at step 8 (1.75).
  check(run(38400, 0, 2.0), {{0, 1.6}, {1, 1.6}, {8, 1.75}});
  // Eighths: 0.3 rounds to 0.5 (wait); off: straight from the key.
  check(run(7200, 6, 1.0), {{0, 0.3}, {1, 0.5}, {2, 0.75}});
  Harness h(256, kArp);
  seqOn(h, {{"arp.quantize", 0}});
  seqPattern(h, R"({"steps":2,"notes":[[0,1,1,100],[1,2,1,100]]})");
  h.run(24000, {{7200, on(60)}});
  auto v = startsByTime();
  CHECK(v.size() >= 3);
  if (v.size() >= 3) { CHECK_NEAR(v[1].beat, 0.3, 1.0 / 24000); CHECK_NEAR(v[2].beat, 0.55, 1.0 / 24000); }
}

// ------------------------------------------------------------ arp / sequencer as mod destinations

// Routes, then a moment for the matrix to run before any key (the arp reads
// global modulation as of the last control block). Event times count from
// h.pos, so resetting it keeps the tests' timings; the engine's own clock
// (not a host's) carries on.
static void route(Harness& h, const char* json) {
  auto r = h.eng->setModMatrix(Json::parse(json));
  CHECK(r.empty());
  h.run(256);
  h.pos = 0;
}

TEST(arp_gate_swing_and_pattern_are_mod_destinations) {
  for (const char* id : {"arp.gate", "arp.swing", "arp.evolve", "arp.pattern", "arp.keyLevel", "arp.seqLevel", "arp.xfade",
                         "arp.phraseAttack", "arp.phraseDecay", "arp.phraseSustain", "arp.phraseRelease"}) {
    Harness h(256, kArp);
    CHECK(h.eng->params().spec(h.param(id)).modulatable);
  }
  {
    // Gate: 50 % plus a constant +0.5 (of its range) holds the note past 0.2 beats.
    Harness h(256, kArp);
    arpOn(h, {{"arp.gate", 50}});
    route(h, R"([{"src":"const","dst":"arp.gate","amt":0.5}])");
    h.run(2400 * 4, {{0, on(60)}});
    CHECK(h.eng->takeStats().activeVoices == 1);
  }
  {
    // Swing: pushed to 100 % by the matrix.
    Harness h(256, kArp);
    arpOn(h);
    route(h, R"([{"src":"const","dst":"arp.swing","amt":1}])");
    h.run(24000, {{0, on(60)}});
    CHECK(gLog.starts.size() >= 2);
    if (gLog.starts.size() >= 2) CHECK_NEAR(gLog.starts[1].beat, 0.25 + 0.25 / 3, 1.0 / 24000);
  }
  {
    // Pattern: 1 + a seventh of the range = pattern 2.
    Harness h(256, kArp);
    seqOn(h);
    seqPattern(h, R"({"steps":1,"notes":[[0,3,1,100]]})", 1);
    route(h, R"([{"src":"const","dst":"arp.pattern","amt":0.15}])");
    h.run(12000, {{0, on(60)}});
    std::vector<int> n;
    for (auto& x : gLog.starts) if (x.arp) n.push_back(x.note);
    CHECK(!n.empty());
    for (int x : n) CHECK(x == 63);
  }
}

TEST(seq_levels_follow_per_voice_modulation) {
  // Seq level from velocity: soft keys make quiet sequences, the key itself unchanged.
  auto seqRms = [](int vel) {
    Harness h(256, kArp);
    seqOn(h, {{"arp.seqLevel", -60}, {"arp.keyLevel", -60}});
    seqPattern(h, R"({"steps":1,"notes":[[0,12,1,127]]})");
    route(h, R"([{"src":"velocity","dst":"arp.seqLevel","amt":1}])");
    h.run(24000);
    MidiEvent e = NoteOn{60, vel / 127.f, 0};
    auto out = h.run(12000, {{h.pos, e}});
    return rmsDb(out, 200, 2800);
  };
  const double loud = seqRms(127), soft = seqRms(40);
  CHECK(loud > -30);
  CHECK(loud - soft > 15);
}

TEST(arp_evolve_and_crossfade_are_modulated) {
  {
    // Evolve set to 0 but pushed to 100 % by the matrix: the pattern changes.
    Harness h(256, kArp);
    seqOn(h, {{"arp.evolve", 0}});
    seqPattern(h, R"({"steps":4,"notes":[[0,3,1,100],[1,5,1,100],[2,7,1,100],[3,10,1,100]]})");
    route(h, R"([{"src":"const","dst":"arp.evolve","amt":1}])");
    h.run(6000 * 4 * 16, {{0, on(60)}});
    std::vector<int> first, later;
    for (auto& x : gLog.starts) if (x.arp) (x.beat < 1.0 - 1e-6 ? first : later).push_back(x.note);
    std::vector<int> repeated;
    for (std::size_t i = 0; i + 4 <= later.size(); i += 4) repeated.insert(repeated.end(), first.begin(), first.end());
    later.resize(repeated.size());
    CHECK(later != repeated);
  }
  {
    // Crossfade time pushed from 1 % to 100 %: two notes overlap mid-step.
    auto overlap = [](bool modulated) {
      Harness h(256, kArp);
      seqOn(h, {{"arp.envMode", 3}, {"arp.xfade", 1}, {"arp.keyLevel", -60}});
      seqPattern(h, R"({"steps":2,"notes":[[0,7,1,100],[1,12,1,100]]})");
      if (modulated) route(h, R"([{"src":"const","dst":"arp.xfade","amt":1}])");
      h.run(6000 + 3000, {{0, on(60)}});
      return h.eng->takeStats().activeVoices;
    };
    CHECK(overlap(false) == 2);   // the key (silent) and one note
    CHECK(overlap(true) == 3);    // and the one fading out
  }
}

TEST(phrase_envelope_is_modulated) {
  // The phrase envelope's value (the arp.phrase source, as the meters see it).
  auto phrase = [](Harness& h) {
    std::vector<float> src(h.eng->modSources().size()), prm(static_cast<std::size_t>(h.eng->params().size())), shp(4);
    h.eng->readModMeters(src.data(), prm.data(), shp.data());
    for (std::size_t i = 0; i < src.size(); ++i)
      if (h.eng->modSources()[i].id == "arp.phrase") return src[i];
    CHECK(false);
    return -1.f;
  };
  {
    // Attack 2 ms, pushed to the top of its range (10 s): still rising after 0.25 s.
    auto level = [&](bool modulated) {
      Harness h(256, kArp);
      arpOn(h, {{"arp.gate", 100}});
      if (modulated) route(h, R"([{"src":"const","dst":"arp.phraseAttack","amt":1}])");
      h.run(6000, {{0, on(60)}});
      return phrase(h);
    };
    CHECK(level(false) > 0.9f);
    CHECK(level(true) < 0.1f);
  }
  {
    // Sustain 1, pulled to 0.5 by the matrix, in the arpeggiator and in a sequencer lane.
    for (bool seq : {false, true}) {
      Harness h(256, kArp);
      if (seq) { seqOn(h, {{"arp.phraseDecay", 0.05}}); seqPattern(h, R"({"steps":1,"notes":[[0,12,1,100]]})"); }
      else arpOn(h, {{"arp.phraseDecay", 0.05}, {"arp.gate", 100}});
      route(h, R"([{"src":"const","dst":"arp.phraseSustain","amt":-0.5}])");
      h.run(24000, {{0, on(60)}});
      CHECK_NEAR(phrase(h), 0.5f, 0.02f);
    }
  }
  {
    // Release 50 ms, pushed to 20 s: the phrase still sounds 0.5 s after the key.
    auto tail = [&](bool modulated) {
      Harness h(256, kArp);
      arpOn(h, {{"arp.gate", 100}});
      if (modulated) route(h, R"([{"src":"const","dst":"arp.phraseRelease","amt":1}])");
      h.run(24000 + 12000, {{0, on(60)}, {24000, off(60)}});
      return phrase(h);
    };
    CHECK(tail(false) < 0.01f);
    CHECK(tail(true) > 0.5f);
  }
}

TEST(seq_generator_writes_intervals) {
  for (int seed = 1; seed < 100; ++seed) {
    Json s = Json::object();
    s["kind"] = 1; s["seed"] = seed; s["range"] = 8;
    Json p = arpGeneratePattern(s);
    bool first = false;
    for (auto& n : p["notes"].items()) {
      const int row = static_cast<int>(n[1].number());
      const int pc = ((row % 12) + 12) % 12;
      CHECK(pc == 0 || pc == 3 || pc == 5 || pc == 7 || pc == 10);   // only intervals that sit well over any key
      first |= n[0].number() == 0;
    }
    CHECK(first);
  }
}

TEST(arp_sources_and_reserved_ids) {
  Harness h(256, kArp);
  bool env = false, phrase = false, step = false;
  for (auto& d : h.eng->modSources()) { env |= d.id == "arp.env"; phrase |= d.id == "arp.phrase"; step |= d.id == "arp.step"; }
  CHECK(env && phrase && step);
  auto r = h.eng->setModMatrix(Json::parse(R"([{"src":"arp.env","dst":"mod","amt":1}])"));
  CHECK(r.empty());
  arpOn(h, {{"arp.decay", 0.01}, {"arp.sustain", 0}, {"arp.gate", 100}});
  h.run(6000, {{0, on(60)}});
  // The note envelope reached the voice's "mod" param: high at the start, gone by the end of the step.
  float first = -1, last = -1;
  for (auto& m : gLog.mods) { first = std::max(first, m.value); last = m.value; }
  CHECK(first > 0.3f && last < 0.05f);
  Harness plain;
  for (auto& d : plain.eng->modSources()) CHECK(d.id.rfind("arp.", 0) != 0);
  CHECK(plain.param("arp.on") < 0);

  struct Clash : TestSynth {
    void defineParams(ParamBuilder& b) override { TestSynth::defineParams(b); b.add("arp.speed").range(0, 1); }
  };
  CHECK_THROWS(Engine(std::make_unique<Clash>(), testInfo(kArp)));
  Engine fine(std::make_unique<Clash>(), testInfo());   // without the feature, the ID is the synth's
  CHECK(fine.params().find("arp.speed") >= 0);
}

int main() {
  for (auto& [name, fn] : registry()) {
    int before = gFail;
    ++gRun;
    fn();
    std::printf("%s  %s\n", gFail == before ? "PASS" : "FAIL", name);
  }
  std::printf("\n%d tests, %d failed checks\n", gRun, gFail);
  return gFail ? 1 : 0;
}
