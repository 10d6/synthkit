// The plugin: a JUCE AudioProcessor around sk::Engine. This is the only place
// (with Editor and Settings) that knows about JUCE.
#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <synthkit/engine.h>
#include <synthkit/multi.h>

#include <array>
#include <atomic>
#include <mutex>
#include <vector>

namespace skplugin {

class Processor;

// A host-visible parameter. The value lives in the engine's ParamStore (so
// the audio thread reads it lock-free); this only translates for the host.
//
// In a multi (API.md §5b) every part has the synth's parameters: part 1 keeps
// the plain IDs, part n > 1 is "p<n>." + the ID, named "P<n> " + the name.
class Parameter : public juce::AudioProcessorParameterWithID {
 public:
  Parameter(sk::ParamStore& store, int index, int part = 0);

  float getValue() const override;
  void setValue(float norm) override;
  float getDefaultValue() const override;
  juce::String getText(float norm, int maxLen) const override;
  float getValueForText(const juce::String& text) const override;
  int getNumSteps() const override;
  bool isDiscrete() const override;
  bool isBoolean() const override;
  juce::StringArray getAllValueStrings() const override;

  int index() const { return index_; }
  int part() const { return part_; }
  const sk::ParamSpec& spec() const { return store_.spec(index_); }

 private:
  sk::ParamStore& store_;
  int index_;
  int part_;
};

// A part's mute or solo (part of the multi's layout, not of any engine; a
// part's level and pan are its patch's master and sk.pan, host parameters
// like the rest of its patch). The host sets the value here; the message thread applies it to
// the layout, and a change made in the window shows up here (Processor::syncMix).
class MixParameter : public juce::AudioProcessorParameterWithID {
 public:
  enum Kind { Mute, Solo, kinds };
  MixParameter(int part, Kind kind);

  float getValue() const override { return norm_.load(std::memory_order_relaxed); }
  void setValue(float norm) override { norm_.store(juce::jlimit(0.f, 1.f, norm), std::memory_order_relaxed); }
  float getDefaultValue() const override { return 0; }
  juce::String getText(float norm, int maxLen) const override;
  float getValueForText(const juce::String& text) const override;
  int getNumSteps() const override { return 2; }
  bool isDiscrete() const override { return true; }
  bool isBoolean() const override { return true; }

  int part() const { return part_; }
  Kind kind() const { return kind_; }
  float fromLayout(const sk::PartSettings& s) const;                  // normalised
  void toLayout(float norm, sk::PartSettings& s) const;

 private:
  std::atomic<float> norm_{0};
  int part_;
  Kind kind_;
};

// What the editor shows in its meters. Written on the audio thread.
struct MeterSnapshot {
  int voices = 0;
  float limiterDb = 0, peak = 0;
  double beat = 0, bpm = 120;
  bool playing = false;
  int num = 4, den = 4;
};

class Processor : public juce::AudioProcessor, private juce::Timer {
 public:
  Processor();
  ~Processor() override;

  // AudioProcessor ------------------------------------------------------------
  const juce::String getName() const override;
  bool acceptsMidi() const override { return true; }
  bool producesMidi() const override { return false; }
  bool isMidiEffect() const override { return false; }
  double getTailLengthSeconds() const override { return 0; }
  int getNumPrograms() override { return 1; }
  int getCurrentProgram() override { return 0; }
  void setCurrentProgram(int) override {}
  const juce::String getProgramName(int) override { return {}; }
  void changeProgramName(int, const juce::String&) override {}

  bool isBusesLayoutSupported(const BusesLayout& layouts) const override;
  void prepareToPlay(double sampleRate, int maxBlock) override;
  void releaseResources() override;
  void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;
  using AudioProcessor::processBlock;

  bool hasEditor() const override { return true; }
  juce::AudioProcessorEditor* createEditor() override;

  void getStateInformation(juce::MemoryBlock& dest) override;
  void setStateInformation(const void* data, int size) override;

  // For the editor (message thread) --------------------------------------------
  // The synth as a Multi (API.md §5b) when it has features.multi: part(i) is an
  // engine of it, and a plain synth has the one engine as part 0.
  bool isMulti() const { return multi_ != nullptr; }
  int partCount() const { return multi_ ? multi_->maxParts() : 1; }
  sk::Engine& engine(int part = 0) { return multi_ ? multi_->part(part) : *owned_; }
  sk::Multi* multi() { return multi_.get(); }
  std::mutex& engineLock() { return engineMutex_; }
  // Part-major: part * paramsPerPart() + the engine's parameter index.
  const std::vector<Parameter*>& params() const { return params_; }
  int paramsPerPart() const { return perPart_; }
  std::size_t slot(int part, int index) const { return static_cast<std::size_t>(part * perPart_ + index); }

  // A change made in the plugin window: applied and reported to the host.
  void setParamFromUi(int part, int index, double value);
  void gesture(int part, int index, bool starting);
  // Patch JSON from the window (preset load). Returns the engine's result.
  sk::LoadResult loadPatchFromUi(int part, const sk::Json& patch);
  // The window's zone editor, and loading a whole multi into it.
  void setLayoutFromUi(const sk::Json& layout);
  sk::LoadResult loadMultiFromUi(const sk::Json& multi);
  // The multi as the window needs it (patches and layout), and bumped when
  // the host changed the layout (a part's level, mute… automated).
  sk::Json multiJson();
  uint32_t layoutSerial() const { return layoutSerial_.load(); }
  sk::Json layoutJson();
  // Tell the host every parameter may have changed (after a patch load).
  void notifyAllParams();

  // MIDI from the on-screen keyboard; played at the start of the next block.
  void queueUiMidi(uint8_t status, uint8_t d1, uint8_t d2);

  // The plugin window's own notes: the preset it shows and whether it's
  // changed. Stored in the DAW project with the patch.
  juce::var uiState() const;
  void setUiState(const juce::var& ui);

  // Bumped whenever the host loads a state, so an open window reloads.
  uint32_t stateSerial() const { return stateSerial_.load(); }

  MeterSnapshot meters();  // takes (and resets) the peak and engine stats
  // Copies the most recent output samples (oldest first).
  void readScope(float* dest, int n) const;

  static constexpr int kScopeSize = 1024;

 private:
  // Parameters the engine moved (mapped MIDI controllers, ctx.setParam):
  // told to the host on the message thread, so it records and shows them.
  void timerCallback() override;

  void syncMix();
  void seedMix();   // the mix parameters from the layout, after a load

  std::unique_ptr<sk::Engine> owned_;    // a synth without features.multi
  std::unique_ptr<sk::Multi> multi_;
  std::vector<Parameter*> params_;
  int perPart_ = 0;
  std::vector<MixParameter*> mix_;       // part * kinds + kind
  std::vector<float> mixAgreed_;         // what the host's parameter and the layout last agreed on
  std::atomic<uint32_t> layoutSerial_{0};
  std::vector<std::atomic<bool>> inGesture_;
  mutable std::mutex engineMutex_;   // non-audio engine calls (patches, mod, custom)
  mutable std::mutex uiStateMutex_;
  juce::var uiState_;
  std::atomic<uint32_t> stateSerial_{0};

  std::vector<sk::MidiEvent> events_;
  juce::AbstractFifo uiFifo_{512};
  std::array<std::array<uint8_t, 3>, 512> uiMidi_{};

  std::array<std::atomic<float>, kScopeSize> scope_{};
  std::atomic<int> scopePos_{0};
  std::atomic<float> peak_{0};
  std::atomic<int> voices_{0};
  std::atomic<float> limiterDb_{0};
  std::atomic<double> beat_{0}, bpm_{120};
  std::atomic<bool> playing_{false};
  std::atomic<int> num_{4}, den_{4};

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(Processor)
};

}  // namespace skplugin
