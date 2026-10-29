// Compiled into each synth (not into synthkit_core), because it depends on
// the synth's SK_SYNTH and embedded synth.json.
#include "synthkit/engine.h"

namespace sk {

std::unique_ptr<Engine> makeEngine() {
  SynthInfo info = SynthInfo::fromJson(Json::parse(embeddedSynthJson()));
  return std::make_unique<Engine>(sk_createSynth(), info);
}

}  // namespace sk
