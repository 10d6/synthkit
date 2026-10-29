// Unit tests for synthkit core. Deliberately dependency-free: a few macros
// and a test synth defined right here.
#include <synthkit/engine.h>

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
  struct Start { int note; Beats beat; double pitch; bool legato; };
  std::vector<Start> starts;
};
static Log gLog;

struct TestSynth;

struct TestVoice : Voice {
  explicit TestVoice(TestSynth& s) : synth(s) {}
  void start(const NoteOn&, const StartInfo& s) override {
    pendingLog = true;
    wasLegato = s.legato;
    if (!s.sounding) phase = 0;
  }
  void render(VoiceContext& ctx, Buffer& out) override;
  TestSynth& synth;
  double phase = 0;
  bool pendingLog = false, wasLegato = false;
};

struct Table { std::array<float, 128> cents{}; };

struct TestSynth : Synth {
  Param gain;
  Custom<Table> table;
  bool scheduleFifth = false;
  int jumps = 0;

  void defineParams(ParamBuilder& b) override { gain = b.add("gain").range(0, 1).def(0.5); }
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
      ctx.out(e);
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
  if (pendingLog) { gLog.starts.push_back({ctx.key(), ctx.transport().beat, ctx.pitch(), wasLegato}); pendingLog = false; }
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
  explicit Harness(int block = 256, const char* extra = "") {
    auto s = std::make_unique<TestSynth>();
    synth = s.get();
    eng = std::make_unique<Engine>(std::move(s), testInfo(extra));
    eng->prepare(sr, block);
    ht.valid = true;
    ht.bpm = 120;
    gLog.starts.clear();
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
      if (ht.playing) ht.beat = pos / sr * ht.bpm / 60.0;
      float* o[2] = {l.data(), r.data()};
      eng->process(o, 2, b, ev.data(), static_cast<int>(ev.size()), ht);
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
