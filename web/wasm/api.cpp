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
  return j;
}

}  // namespace

SK_EXPORT(sk_init) int sk_init() {
  if (gEngine) return 1;
  sk::setErrorHandler(onError);
  gEngine = sk::makeEngine();
  gEvents.reserve(1024);
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

SK_EXPORT(sk_process) void sk_process(int frames, double bpm, int playing, double beat, int num, int den) {
  sk::HostTransport t;
  t.valid = true;
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

SK_EXPORT(sk_all_notes_off) void sk_all_notes_off() { gEngine->allNotesOff(); }
SK_EXPORT(sk_panic) void sk_panic() { gEngine->panic(); }
