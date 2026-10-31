// The plugin: a JUCE AudioProcessor around sk::Engine. This is the only place
// (with Editor and Settings) that knows about JUCE.
#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <synthkit/engine.h>

#include <array>
#include <atomic>
#include <mutex>
#include <vector>

namespace skplugin {

class Processor;

// A host-visible parameter. The value lives in the engine's ParamStore (so
// the audio thread reads it lock-free); this only translates for the host.
class Parameter : public juce::AudioProcessorParameterWithID {
 public:
  Parameter(sk::ParamStore& store, int index);

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
  const sk::ParamSpec& spec() const { return store_.spec(index_); }

 private:
  sk::ParamStore& store_;
  int index_;
};

// What the editor shows in its meters. Written on the audio thread.
struct MeterSnapshot {
  int voices = 0;
  float limiterDb = 0, peak = 0;
  double beat = 0, bpm = 120;
  bool playing = false;
  int num = 4, den = 4;
};

class Processor : public juce::AudioProcessor {
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
  sk::Engine& engine() { return *engine_; }
  std::mutex& engineLock() { return engineMutex_; }
  const std::vector<Parameter*>& params() const { return params_; }

  // A change made in the plugin window: applied and reported to the host.
  void setParamFromUi(int index, double value);
  void gesture(int index, bool starting);
  // Patch JSON from the window (preset load). Returns the engine's result.
  sk::LoadResult loadPatchFromUi(const sk::Json& patch);
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
  std::unique_ptr<sk::Engine> engine_;
  std::vector<Parameter*> params_;
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
