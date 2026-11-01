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
    int standardLfos = 0;   // LFOs the synth has (with userLfos: the most the player can add)
    bool userLfos = false;  // the player adds and removes LFOs (sk.lfos says how many are in use)
    int lfosStart = 0;      // with userLfos: how many a new patch starts with
    int modSlots = 0;
    int shapes = 0;
    int eventQueue = 256;
    bool tempoInPatch = false;   // the browser's tempo and time signature are saved in patches
  } features;

  static SynthInfo fromJson(const Json& j);  // throws std::invalid_argument
};

struct EngineStats {
  int activeVoices = 0;
  float limiterReductionDb = 0;   // max since last call
  float peakBeforeLimiterDb = -120;
  int droppedEvents = 0;          // queue overflows since last call
  int steals = 0;
  int droppedMessages = 0;        // message queue overflows since last call
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

  // Modulation, for UIs. Sources in matrix order; the matrix and shapes as
  // their patch JSON ("mod" / "shapes").
  std::vector<ModSourceDesc> modSources() const;
  int modSlots() const;
  int lfoCount() const;
  int shapeCount() const;
  Json modMatrix() const;
  std::vector<std::string> setModMatrix(const Json& routes);  // returns warnings
  Json shapes() const;
  std::vector<std::string> setShapes(const Json& shapes);
  // Latest values from the audio thread: one per source, one per parameter
  // (NaN when not modulated), and (phase or -1, value) per shape. Values are
  // for the most recently started voice, or global when none is sounding.
  void readModMeters(float* sources, float* params, float* shapes) const;

  // Messages (API.md §9b). Ids in declaration order; index -1 if unknown.
  const std::vector<std::string>& messageIds() const;
  int messageIndex(const std::string& id) const;
  // From the page: one producer thread (the UI or message thread). Delivered
  // at the start of the next block. False if the queue is full.
  bool sendMessage(int index, const float* values, int count);
  // To the page: one consumer thread. False when there are none waiting.
  bool takeMessage(Message& out);

  // Parameters the audio thread moved (MIDI controllers, ctx.setParam), for
  // adapters to tell the host and the page. One consumer thread.
  bool takeParamChange(int& index);

  // The tempo saved in the current patch (features.tempoInPatch). False when
  // the patch has none.
  bool patchTempo(double& bpm, int& num, int& den) const;
  void setPatchTempo(double bpm, int num, int den);

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
