// Internal: the kit's step sequencer (API.md §4b, arp.on = Sequencer). Owned
// by the engine core; not part of the public API.
//
// Each key plays as usual and also starts its own copy of a drawn pattern
// whose rows are intervals from that key: semitones, or scale steps when a
// scale is set. Every key has its own lane: its own step clock and its own
// phrase envelope, which keeps the sequence playing through its release
// after the key is let go. The lanes run sample by sample like the
// arpeggiator, so the result doesn't depend on the block size.
#pragma once

#include <array>
#include <vector>

#include "arp.h"

namespace sk::detail {

class Seq {
 public:
  static constexpr int kLanes = 16;
  static constexpr int kMaxOffs = 256;

  void setBank(const CustomSlot<ArpBank>* bank) { bank_ = bank; }
  void prepare(double sampleRate, int maxBlock);
  void reset();
  void requestAllOff() { allOff_ = true; }

  void process(const ArpParams& P, const MidiEvent* in, int nIn, MidiEvent* out, int& outCount, int outCap, int& dropped,
               const ParamStore& store, Beats blockStart, double spb, int frames, const Transport& t, bool jumped);

  // A lane's phrase envelope for this block, one value per sample.
  const float* phrase(int lane) const { return phraseBuf_.data() + static_cast<std::size_t>(std::clamp(lane, 0, kLanes - 1)) * maxBlock_; }
  // For the mod sources: the most recently started lane.
  float phraseAt(int sample) const { return latest_ >= 0 ? phrase(latest_)[std::clamp(sample, 0, maxBlock_ - 1)] : 0.f; }
  float stepPosAt(int sample) const;

 private:
  struct Lane {
    bool used = false;
    bool gate = false;          // key held (or latched)
    int key = 0, channel = 0;
    float vel = 0;
    dsp::Adsr env;
    Beats gridBeat = 0, stepBeat = 0;
    long step = 0;
    uint64_t serial = 0;
    dsp::Rng rng{1};
    ArpPattern evolved{};
    int evolvedFrom = -1;
    uint32_t evolvedGen = 0;
  };
  struct Off { Beats beat = 0; int note = 0; int channel = 0; int lane = 0; };

  int choice(int i) const { return i >= 0 ? static_cast<int>(std::lround(store_->get(i))) : 0; }
  float get(int i) const { return i >= 0 ? store_->get(i) : 0.f; }
  double stepLen() const { return arpRateBeats(choice(P_->rate)); }
  int sampleOf(Beats b) const;
  void emit(MidiEvent e, int sample);
  void flushOffs(int sample, bool all, int lane = -1);
  void advanceEnvs(int to);
  void handle(const MidiEvent& e);
  void startLane(int li, const MidiEvent& e, Beats keyBeat);
  void releaseKey(int note);
  void clearAll(bool hard);
  void step(int li, int sample);
  int heldKeys() const;

  const ArpParams* P_ = nullptr;
  const CustomSlot<ArpBank>* bank_ = nullptr;
  double sr_ = 48000;
  int maxBlock_ = 1;
  std::vector<float> phraseBuf_;   // kLanes × maxBlock

  // Per block.
  const ParamStore* store_ = nullptr;
  MidiEvent* out_ = nullptr;
  int* outCount_ = nullptr;
  int outCap_ = 0;
  int* dropped_ = nullptr;
  Beats blockStart_ = 0;
  double spb_ = 24000;
  int frames_ = 0;
  int envPos_ = 0;
  const Transport* t_ = nullptr;

  std::array<Lane, kLanes> lanes_{};
  std::array<Off, kMaxOffs> offs_{};
  int nOffs_ = 0;
  std::array<uint8_t, 128> down_{};
  std::array<bool, 128> sustained_{};
  bool pedal_ = false;
  bool wasOn_ = false, allOff_ = false;
  uint64_t serial_ = 0;
  int latest_ = -1;
  float stepPos_ = 0, stepPosStart_ = 0;
  static constexpr int kMaxStepMarks = 256;
  std::array<std::pair<int, float>, kMaxStepMarks> stepMarks_{};
  int nStepMarks_ = 0;
};

}  // namespace sk::detail
