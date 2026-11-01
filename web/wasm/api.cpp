// C API exported to JavaScript by the WebAssembly build. Two instances of the
// same module run in the browser: one on the AudioWorklet thread (makes the
// sound) and one on the page (the UI's model: formatting, patches,
// validation). Strings cross the boundary as NUL-terminated UTF-8; returned
// strings stay valid until the next call that returns a string.
#include <synthkit/engine.h>

#include <cmath>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#define SK_EXPORT(name) extern "C" __attribute__((export_name(#name)))

extern "C" __attribute__((import_module("env"), import_name("sk_log"))) void js_log(const char* msg, int len);

namespace {

std::unique_ptr<sk::Engine> gEngine;
std::string gStr;
std::vector<sk::MidiEvent> gEvents;
std::vector<float> gL, gR;
float gStats[8] = {};
// Mod meters, sized once in sk_init so reading them on the audio thread doesn't allocate.
std::vector<float> gMeters;
std::size_t gMeterSources = 0, gMeterParams = 0;
// Messages to the page, drained after each block: [index, count, v0..v3] each.
constexpr int kMsgBatch = 64;
float gMsgOut[kMsgBatch * 6] = {};

const char* ret(std::string s) {
  gStr = std::move(s);
  return gStr.c_str();
}

void onError(const char* msg) { js_log(msg, static_cast<int>(std::strlen(msg))); }

sk::Json specJson(const sk::ParamSpec& s) {
  sk::Json j = sk::Json::object();
  j["id"] = s.id;
  j["name"] = s.name;
  j["unit"] = s.unit;
  j["group"] = s.group;
  const char* types[] = {"float", "int", "choice", "toggle"};
  j["type"] = types[static_cast<int>(s.type)];
  j["min"] = s.min;
  j["max"] = s.max;
  j["def"] = s.def;
  j["step"] = s.step;
  const char* curves[] = {"linear", "log", "exp"};
  j["curve"] = curves[static_cast<int>(s.curve)];
  if (!s.choices.empty()) j["choices"] = sk::Json(s.choices);
  j["modulatable"] = s.modulatable;
  j["hidden"] = s.hidden;
  j["kit"] = s.kit;
  if (!s.controllers.empty()) {
    sk::Json cs = sk::Json::array();
    for (auto& c : s.controllers) {
      sk::Json cj = sk::Json::object();
      cj["cc"] = c.cc;
      cj["lo"] = c.lo;
      cj["hi"] = c.hi;
      cs.push(cj);
    }
    j["controllers"] = cs;
  }
  return j;
}

}  // namespace

SK_EXPORT(sk_init) int sk_init() {
  if (gEngine) return 1;
  sk::setErrorHandler(onError);
  gEngine = sk::makeEngine();
  gEvents.reserve(1024);
  gMeterSources = gEngine->modSources().size();
  gMeterParams = static_cast<std::size_t>(gEngine->params().size());
  gMeters.assign(gMeterSources + gMeterParams + static_cast<std::size_t>(gEngine->shapeCount()) * 2, 0.f);
  return 1;
}

SK_EXPORT(sk_alloc) void* sk_alloc(int n) { return std::malloc(static_cast<std::size_t>(n > 0 ? n : 1)); }
SK_EXPORT(sk_free) void sk_free(void* p) { std::free(p); }

// Everything the UI needs to build itself: synth identity, parameter specs,
// factory presets and custom-state ids.
SK_EXPORT(sk_info) const char* sk_info() {
  const auto& info = gEngine->info();
  sk::Json j = sk::Json::object();
  sk::Json s = sk::Json::object();
  s["id"] = info.id;
  s["name"] = info.name;
  s["vendor"] = info.vendor;
  s["version"] = info.version;
  s["voices"] = info.features.voices;
  s["voiceModes"] = sk::Json(info.features.voiceModes);
  s["standardEnvelopes"] = info.features.standardEnvelopes;
  s["ampEnv"] = info.features.ampEnv;
  s["tempoInPatch"] = info.features.tempoInPatch;
  j["synth"] = s;
  sk::Json params = sk::Json::array();
  auto& ps = gEngine->params();
  for (int i = 0; i < ps.size(); ++i) params.push(specJson(ps.spec(i)));
  j["params"] = params;
  sk::Json presets = sk::Json::array();
  int n = 0;
  const sk::EmbeddedPreset* p = sk::embeddedPresets(n);
  for (int i = 0; i < n; ++i) {
    sk::Json pj;
    std::string err;
    sk::Json entry = sk::Json::object();
    entry["path"] = p[i].path;
    if (sk::Json::tryParse(p[i].json, pj, &err)) entry["patch"] = pj;
    else entry["error"] = err;
    presets.push(entry);
  }
  j["presets"] = presets;
  j["custom"] = sk::Json(gEngine->customIds());
  j["messages"] = sk::Json(gEngine->messageIds());
  sk::Json mod = sk::Json::object();
  sk::Json srcs = sk::Json::array();
  for (const auto& d : gEngine->modSources()) {
    sk::Json sj = sk::Json::object();
    sj["id"] = d.id;
    sj["name"] = d.name;
    sj["perVoice"] = d.perVoice;
    sj["bipolar"] = d.bipolar;
    srcs.push(sj);
  }
  mod["sources"] = srcs;
  mod["slots"] = gEngine->modSlots();
  mod["lfos"] = gEngine->lfoCount();
  mod["shapes"] = gEngine->shapeCount();
  j["mod"] = mod;
  return ret(j.dump(0));
}

SK_EXPORT(sk_prepare) void sk_prepare(double sampleRate, int maxBlock) {
  gL.assign(static_cast<std::size_t>(maxBlock), 0.f);
  gR.assign(static_cast<std::size_t>(maxBlock), 0.f);
  gEngine->prepare(sampleRate, maxBlock);
}
SK_EXPORT(sk_left) float* sk_left() { return gL.data(); }
SK_EXPORT(sk_right) float* sk_right() { return gR.data(); }

SK_EXPORT(sk_midi) void sk_midi(int sample, int status, int d1, int d2) {
  if (gEvents.size() >= gEvents.capacity()) return;
  uint8_t b[3] = {static_cast<uint8_t>(status), static_cast<uint8_t>(d1), static_cast<uint8_t>(d2)};
  sk::MidiEvent e;
  if (sk::MidiEvent::fromBytes(b, 3, sample, e)) gEvents.push_back(e);
}

// source: 0 the page's tempo controls, 1 MIDI clock (API.md §7).
SK_EXPORT(sk_process) void sk_process(int frames, double bpm, int playing, double beat, int num, int den, int source) {
  sk::HostTransport t;
  t.valid = true;
  t.source = source == 1 ? sk::TempoSource::MidiClock : sk::TempoSource::Browser;
  t.bpm = bpm;
  t.playing = playing != 0;
  t.beat = beat;
  t.timeSigNum = num;
  t.timeSigDen = den;
  double bpb = num * 4.0 / (den > 0 ? den : 4);
  t.barStart = std::floor(beat / bpb + 1e-9) * bpb;
  float* outs[2] = {gL.data(), gR.data()};
  int n = frames < static_cast<int>(gL.size()) ? frames : static_cast<int>(gL.size());
  gEngine->process(outs, 2, n, gEvents.data(), static_cast<int>(gEvents.size()), t);
  gEvents.clear();
}

SK_EXPORT(sk_param_count) int sk_param_count() { return gEngine->params().size(); }
SK_EXPORT(sk_set_param) void sk_set_param(int i, double v) { gEngine->params().set(i, v); }
SK_EXPORT(sk_get_param) double sk_get_param(int i) { return gEngine->params().get(i); }
SK_EXPORT(sk_to_norm) double sk_to_norm(int i, double v) { return gEngine->params().spec(i).toNorm(v); }
SK_EXPORT(sk_from_norm) double sk_from_norm(int i, double n) { return gEngine->params().spec(i).fromNorm(n); }
SK_EXPORT(sk_clamp) double sk_clamp(int i, double v) { return gEngine->params().spec(i).clamp(v); }
SK_EXPORT(sk_format) const char* sk_format(int i, double v) { return ret(gEngine->params().spec(i).format(v)); }
SK_EXPORT(sk_parse) double sk_parse(int i, const char* text) {
  double v;
  return gEngine->params().spec(i).parse(text, v) ? v : NAN;
}

// Returns {"ok":…, "error":…, "warnings":[…]}.
SK_EXPORT(sk_load_patch) const char* sk_load_patch(const char* text) {
  sk::Json r = sk::Json::object();
  sk::Json patch;
  std::string err;
  if (!sk::Json::tryParse(text, patch, &err)) {
    r["ok"] = false;
    r["error"] = err;
    return ret(r.dump(0));
  }
  auto res = gEngine->loadPatch(patch);
  r["ok"] = res.ok;
  if (!res.ok) r["error"] = res.error;
  r["warnings"] = sk::Json(res.warnings);
  return ret(r.dump(0));
}

SK_EXPORT(sk_save_patch) const char* sk_save_patch() { return ret(gEngine->savePatch().dump(2)); }

SK_EXPORT(sk_set_name) void sk_set_name(const char* name) { gEngine->patchMeta().name = name; }

SK_EXPORT(sk_get_custom) const char* sk_get_custom(const char* id) { return ret(gEngine->customState(id).dump(0)); }
SK_EXPORT(sk_set_custom) int sk_set_custom(const char* id, const char* json) {
  sk::Json v;
  if (!sk::Json::tryParse(json, v)) return 0;
  return gEngine->setCustomState(id, v) ? 1 : 0;
}

// [activeVoices, limiterReductionDb, peakBeforeLimiterDb, droppedEvents, steals]
SK_EXPORT(sk_stats) float* sk_stats() {
  auto s = gEngine->takeStats();
  gStats[0] = static_cast<float>(s.activeVoices);
  gStats[1] = s.limiterReductionDb;
  gStats[2] = s.peakBeforeLimiterDb;
  gStats[3] = static_cast<float>(s.droppedEvents);
  gStats[4] = static_cast<float>(s.steals);
  return gStats;
}

SK_EXPORT(sk_get_mod) const char* sk_get_mod() { return ret(gEngine->modMatrix().dump(0)); }
SK_EXPORT(sk_set_mod) const char* sk_set_mod(const char* json) {
  sk::Json v;
  if (!sk::Json::tryParse(json, v)) return ret("[\"not valid JSON\"]");
  return ret(sk::Json(gEngine->setModMatrix(v)).dump(0));
}
SK_EXPORT(sk_get_shapes) const char* sk_get_shapes() { return ret(gEngine->shapes().dump(0)); }
SK_EXPORT(sk_set_shapes) const char* sk_set_shapes(const char* json) {
  sk::Json v;
  if (!sk::Json::tryParse(json, v)) return ret("[\"not valid JSON\"]");
  return ret(sk::Json(gEngine->setShapes(v)).dump(0));
}

// Mod meters: [sources…, params… (NaN = unmodulated), (phase, value) per shape].
SK_EXPORT(sk_mod_meters) float* sk_mod_meters() {
  gEngine->readModMeters(gMeters.data(), gMeters.data() + gMeterSources, gMeters.data() + gMeterSources + gMeterParams);
  return gMeters.data();
}
SK_EXPORT(sk_mod_meter_count) int sk_mod_meter_count() { return static_cast<int>(gMeters.size()); }

// A message from the page (API.md §9b), delivered at the next block.
SK_EXPORT(sk_message) int sk_message(int index, int count, double a, double b, double c, double d) {
  const float v[4] = {static_cast<float>(a), static_cast<float>(b), static_cast<float>(c), static_cast<float>(d)};
  return gEngine->sendMessage(index, v, count) ? 1 : 0;
}
// Messages the engine posted since the last call: returns how many, laid out
// in sk_message_buffer() as [index, count, v0, v1, v2, v3] each.
SK_EXPORT(sk_take_messages) int sk_take_messages() {
  int n = 0;
  sk::Message m;
  while (n < kMsgBatch && gEngine->takeMessage(m)) {
    float* o = gMsgOut + n * 6;
    o[0] = static_cast<float>(m.id.index);
    o[1] = static_cast<float>(m.count);
    for (int i = 0; i < 4; ++i) o[2 + i] = m.values[static_cast<std::size_t>(i)];
    ++n;
  }
  return n;
}
SK_EXPORT(sk_message_buffer) float* sk_message_buffer() { return gMsgOut; }

// Parameters the engine moved (mapped MIDI controllers, ctx.setParam): up to
// kChangeBatch indices into sk_param_change_buffer(); the page reads their
// values with sk_get_param.
constexpr int kChangeBatch = 256;
static int gChangeOut[kChangeBatch];
SK_EXPORT(sk_take_param_changes) int sk_take_param_changes() {
  int n = 0, i = 0;
  while (n < kChangeBatch && gEngine->takeParamChange(i)) gChangeOut[n++] = i;
  return n;
}
SK_EXPORT(sk_param_change_buffer) int* sk_param_change_buffer() { return gChangeOut; }

// The patch's tempo (features.tempoInPatch): "" when it has none.
SK_EXPORT(sk_patch_tempo) const char* sk_patch_tempo() {
  double bpm;
  int num, den;
  if (!gEngine->patchTempo(bpm, num, den)) return ret(std::string());
  sk::Json t = sk::Json::object();
  t["bpm"] = bpm;
  t["num"] = num;
  t["den"] = den;
  return ret(t.dump(0));
}
SK_EXPORT(sk_set_patch_tempo) void sk_set_patch_tempo(double bpm, int num, int den) { gEngine->setPatchTempo(bpm, num, den); }

SK_EXPORT(sk_all_notes_off) void sk_all_notes_off() { gEngine->allNotesOff(); }
SK_EXPORT(sk_panic) void sk_panic() { gEngine->panic(); }
