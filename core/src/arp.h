// Internal: the kit's arpeggiator (API.md §4b). Owned by the engine core; not
// part of the public API.
//
// It sits between the synth's processEvents and the voices. Each block it
// takes the (sorted) events, keeps the keys it arpeggiates, passes everything
// else on, and writes the notes it plays, flagged MidiEvent::arp. It also runs
// the phrase envelope sample by sample, so whether the tail of a phrase is
// still playing is decided at the exact sample, whatever the block size.
#pragma once

#include <array>
#include <cstdint>
#include <vector>

#include "synthkit/dsp/envelopes.h"
#include "synthkit/dsp/rng.h"
#include "synthkit/midi.h"
#include "synthkit/params.h"
#include "synthkit/transport.h"

namespace sk::detail {

enum ArpMode { ArpUp, ArpDown, ArpUpDown, ArpDownUp, ArpAsPlayed, ArpRandom, ArpChord };
enum ArpEnvMode { ArpEnvOff, ArpEnvMultiply, ArpEnvReplace };
enum ArpSync { ArpSyncGrid, ArpSyncKey };

struct ArpParams {
  int on = -1, mode = -1, octaves = -1, rate = -1, gate = -1, swing = -1, latch = -1, sync = -1;
  int velMode = -1, velFixed = -1;
  int envMode = -1, a = -1, d = -1, s = -1, r = -1;      // note envelope
  int pa = -1, pd = -1, ps = -1, pr = -1;                // phrase envelope
};

const std::vector<std::string>& arpRateNames();

class Arp {
 public:
  static constexpr int kMaxNotes = 32;
  static constexpr int kMaxOffs = 128;

  void addParams(ParamBuilder& b);
  const ArpParams& params() const { return P; }

  void prepare(double sampleRate, int maxBlock);
  void reset();  // panic: silence, forget everything
  // The kit's all notes off: let go of everything at the next block, even
  // when the synth's processEvents keeps CC 123 to itself.
  void requestAllOff() { allOff_ = true; }

  // One block. `in` is sorted by sample. Events the arp doesn't keep, and the
  // notes it plays, are appended to out[outCount…]; returns false for each
  // event that didn't fit (the caller counts drops).
  void process(const MidiEvent* in, int nIn, MidiEvent* out, int& outCount, int outCap, int& dropped,
               const ParamStore& store, Beats blockStart, double spb, int frames, const Transport& t, bool jumped);

  // Phrase envelope for this block, one value per sample.
  const float* phrase() const { return phraseBuf_.data(); }
  // Position in the pattern's cycle (0…1, stepped) at a sample of this block.
  float stepPosAt(int sample) const;
  bool running() const { return running_; }

 private:
  struct Entry { int note = 0; float vel = 0; int channel = 0; uint64_t order = 0; bool gone = false; Beats goneAt = 0; };
  struct Off { Beats beat = 0; int note = 0; int channel = 0; };

  int sampleOf(Beats b) const;
  void advanceEnv(int to);
  void emit(MidiEvent e, int sample);
  void flushOffs(int sample, bool all);   // fire offs due at or before `sample` (or all)
  void handle(const MidiEvent& e);
  void newPhrase(const MidiEvent& e);
  void addNote(const MidiEvent& e);
  void keyUp(int note);
  void unlatch();
  void clearAll(bool hard);
  void start(Beats keyBeat);
  void step(int sample);
  double stepLen() const;
  int heldKeys() const;
  int activeNotes(int* notes, float* vels, int* chans, bool byOrder) const;

  ArpParams P;
  double sr_ = 48000;
  std::vector<float> phraseBuf_;
  dsp::Adsr phraseEnv_;
  dsp::Rng rng_{0xA4F};

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
  float get(int i) const { return i >= 0 ? store_->get(i) : 0.f; }
  int choice(int i) const;

  // State.
  std::array<Entry, kMaxNotes> chord_{};
  int nChord_ = 0;
  uint64_t orderCounter_ = 0;
  std::array<uint8_t, 128> down_{};       // key presses per note (any channel)
  std::array<bool, 128> sustained_{};     // key up while the pedal was down
  bool pedal_ = false;
  bool gateOn_ = false;                   // phrase envelope's gate
  bool wasOn_ = false, wasLatched_ = false;
  bool allOff_ = false;
  bool running_ = false;
  Beats gridBeat_ = 0;                    // next step's unswung grid position
  Beats stepBeat_ = 0;                    // next step's actual position
  long stepIndex_ = 0;                    // steps since the phrase started
  int lastRandom_ = -1;
  float stepPos_ = 0;
  float stepPosStart_ = 0;                // at this block's start
  static constexpr int kMaxStepMarks = 256;
  std::array<std::pair<int, float>, kMaxStepMarks> stepMarks_{};
  int nStepMarks_ = 0;
  uint64_t phraseCount_ = 0;
  std::array<Off, kMaxOffs> offs_{};
  int nOffs_ = 0;
};

}  // namespace sk::detail
