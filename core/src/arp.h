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

#include "synthkit/custom.h"
#include "synthkit/dsp/envelopes.h"
#include "synthkit/dsp/rng.h"
#include "synthkit/midi.h"
#include "synthkit/params.h"
#include "synthkit/transport.h"

namespace sk::detail {

enum ArpMode { ArpUp, ArpDown, ArpUpDown, ArpDownUp, ArpAsPlayed, ArpRandom, ArpChord, ArpPatternMode };

// Custom patterns (API.md §4b), drawn in the piano roll. Rows are chord
// tones: row 0 is the lowest held note, row 1 the next, and rows past the
// held notes carry on an octave up (below 0, an octave down).
constexpr int kArpPatterns = 8;
constexpr int kArpMaxSteps = 64;
constexpr int kArpMaxPatternNotes = 256;
constexpr int kArpRowLow = -24, kArpRowHigh = 47;

struct ArpPatternNote {
  int16_t step = 0;     // 0…steps-1
  int16_t row = 0;      // chord tone
  int16_t len = 1;      // in steps
  uint8_t vel = 100;    // 1…127
  uint8_t chance = 100; // 0…100 %
};

struct ArpPattern {
  int steps = 16;
  int count = 0;
  std::array<ArpPatternNote, kArpMaxPatternNotes> notes{};
};

struct ArpBank {
  std::array<ArpPattern, kArpPatterns> patterns{};
};

// The pattern generator (arpgen.cpp): a seeded, musical random pattern.
struct ArpGenSettings {
  int steps = 16;
  float density = 0.6f;      // how many steps play (strong steps first)
  int range = 5;             // how many chord tones the line spans
  float leaps = 0.3f;        // jumps rather than steps
  float repetition = 0.6f;   // motifs repeat (AABA) rather than vary (ABCD)
  float ties = 0.2f;         // notes held into the rests after them
  float chords = 0.f;        // a second chord tone on strong steps
  uint64_t seed = 1;
  // What rows mean: 0 chord tones (the arpeggiator), 1 semitones and 2
  // scale steps (the sequencer: a line above the key, starting mid-range).
  int kind = 0;
};
void arpGenerate(const ArpGenSettings& g, ArpPattern& out);
// Evolve: change a note or two of `work` (a copy of `original`) for the next
// cycle, keeping it recognisable. Allocation-free.
void arpEvolve(const ArpPattern& original, ArpPattern& work, float amount, dsp::Rng& r);

ArpBank arpDefaultBank();
ArpBank arpDefaultSeqBank();   // the sequencer's: rows are intervals
void arpSaveBank(const ArpBank& b, Json& j);
void arpLoadBank(const Json& j, ArpBank& b);
enum ArpEnvMode { ArpEnvOff, ArpEnvMultiply, ArpEnvReplace, ArpEnvCrossfade };
enum ArpType { ArpTypeOff, ArpTypeArp, ArpTypeSeq };   // arp.on
enum ArpSync { ArpSyncGrid, ArpSyncKey };

struct ArpParams {
  int on = -1, mode = -1, octaves = -1, rate = -1, gate = -1, swing = -1, latch = -1, sync = -1;
  int velMode = -1, velFixed = -1, pattern = -1, evolve = -1;
  int scale = -1, scaleKey = -1, keyLevel = -1, seqLevel = -1, seqSync = -1;   // sequencer
  int quantize = -1, quantizeTo = -1;
  int envMode = -1, a = -1, d = -1, s = -1, r = -1, xfade = -1;               // note envelope
  int pa = -1, pd = -1, ps = -1, pr = -1;                // phrase envelope
};

const std::vector<std::string>& arpRateNames();
double arpRateBeats(int choiceIndex);

// Scales for the sequencer (arp.scale): semitones of each degree above the
// scale's root. Index 0 is Chromatic (no scale).
struct ArpScale { const char* name; int n; int steps[12]; };
const ArpScale& arpScale(int index);
int arpScaleCount();
// The pitch `degrees` scale steps from `key` (0 is the key itself).
int arpScalePitch(int key, int degrees, int scaleIndex, int scaleRoot);

class Arp {
 public:
  static constexpr int kMaxNotes = 32;
  static constexpr int kMaxOffs = 128;

  void addParams(ParamBuilder& b);
  void setBank(const CustomSlot<ArpBank>* bank) { bank_ = bank; }
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
  bool crossfade() const { return choice(P.envMode) == ArpEnvCrossfade; }

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
  const CustomSlot<ArpBank>* bank_ = nullptr;
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
  // Evolve: the pattern as it's playing now, varied cycle by cycle.
  ArpPattern evolved_{};
  int evolvedFrom_ = -1;                  // pattern index it was copied from
  uint32_t evolvedGen_ = 0;               // the bank's generation then
  dsp::Rng evolveRng_{0xE70};
  int nOffs_ = 0;
};

}  // namespace sk::detail
