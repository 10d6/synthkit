// Compiled into each synth (not into synthkit_core), because it depends on
// the synth's SK_SYNTH and embedded synth.json.
#include <cstring>

#include "synthkit/engine.h"
#include "synthkit/multi.h"

namespace sk {

std::unique_ptr<Engine> makeEngine() {
  SynthInfo info = SynthInfo::fromJson(Json::parse(embeddedSynthJson()));
  return std::make_unique<Engine>(sk_createSynth(), info);
}

namespace {

// "presets/pads/warm.json" -> "pads/warm"
std::string presetKeyOf(const std::string& path) {
  std::string k = path;
  if (k.rfind("presets/", 0) == 0) k = k.substr(8);
  if (k.size() > 5 && k.compare(k.size() - 5, 5, ".json") == 0) k.resize(k.size() - 5);
  return k;
}

}  // namespace

std::unique_ptr<Multi> makeMulti() {
  auto m = std::make_unique<Multi>([] { return makeEngine(); });
  m->setPresetResolver([](const std::string& key, Json& patch) {
    int n = 0;
    const EmbeddedPreset* p = embeddedPresets(n);
    const std::string want = presetKeyOf(key);
    for (int i = 0; i < n; ++i) {
      if (presetKeyOf(p[i].path) != want) continue;
      return Json::tryParse(p[i].json, patch);
    }
    return false;
  });
  return m;
}

}  // namespace sk
