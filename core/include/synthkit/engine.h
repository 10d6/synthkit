// The runtime that hosts a Synth. Adapters (render tool, web, plugin) talk
// to this; synths never need to.
#pragma once

#include <memory>
#include <string>
#include <vector>

#include "synthkit/synth.h"

namespace sk {

struct SynthInfo {
  std::string id, name, vendor, version, pluginCode, vendorCode;
  int patchVersion = 1;
  struct Features {
    int voices = 8;
    std::vector<std::string> voiceModes{"poly"};
    bool unison = false;
    int standardEnvelopes = 1;
    bool ampEnv = true;     // env1 shapes each voice's output
    int standardLfos = 0;   // phase 4
    int modSlots = 0;       // phase 4
    int shapes = 0;         // phase 4
    int eventQueue = 256;
  } features;

  static SynthInfo fromJson(const Json& j);  // throws std::invalid_argument
};

struct EngineStats {
  int activeVoices = 0;
  float limiterReductionDb = 0;   // max since last call
  float peakBeforeLimiterDb = -120;
  int droppedEvents = 0;          // queue overflows since last call
  int steals = 0;
};

class Engine {
 public:
  Engine(std::unique_ptr<Synth> synth, SynthInfo info);
  ~Engine();
  Engine(const Engine&) = delete;
  Engine& operator=(const Engine&) = delete;

  const SynthInfo& info() const;
  Synth& synth();
  ParamStore& params();
  const ParamStore& params() const;

  void prepare(double sampleRate, int maxBlock);
  void releaseResources();

  // Events must be sorted by sample offset. outs: 1 (mono) or 2 channels.
  void process(float* const* outs, int numOutputs, int frames,
               const MidiEvent* events, int numEvents, const HostTransport& transport);

  void allNotesOff();  // thread-safe request, handled at the next block
  void panic();        // immediate silence at the next block

  Json savePatch() const;
  LoadResult loadPatch(const Json& patch);
  PatchMeta& patchMeta();

  // Custom state access for UIs: by id, as JSON.
  Json customState(const std::string& id) const;
  bool setCustomState(const std::string& id, const Json& value);
  std::vector<std::string> customIds() const;

  EngineStats takeStats();
  const Transport& transport() const;

 private:
  std::unique_ptr<detail::Core> core_;
};

// Provided by the build (SK_SYNTH + embedded synth.json/presets).
struct EmbeddedPreset {
  const char* path;
  const char* json;
};
const char* embeddedSynthJson();
const EmbeddedPreset* embeddedPresets(int& count);
std::unique_ptr<Engine> makeEngine();  // createSynth + synth.json

}  // namespace sk

std::unique_ptr<::sk::Synth> sk_createSynth();
