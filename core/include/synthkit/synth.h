// The interfaces a synth implements: Synth (parameters, voices, optional
// hooks) and Voice (the sound). See API.md for the contract.
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "synthkit/custom.h"
#include "synthkit/dsp.h"
#include "synthkit/json.h"
#include "synthkit/midi.h"
#include "synthkit/modulation.h"
#include "synthkit/params.h"
#include "synthkit/patch.h"
#include "synthkit/transport.h"

namespace sk {

namespace detail { struct Core; struct Slot; }

inline constexpr int kControlBlock = 32;  // samples per control-rate step

struct PrepareInfo {
  double sampleRate = 48000;
  int maxBlock = 512;
  const ParamStore* params = nullptr;

  // Any parameter by ID, including the kit's (env1.sustain, master, …), for
  // use with ctx.get(). Reports an unknown ID with sk::fail.
  Param param(std::string_view id) const;
};

// Stereo scratch buffer a voice ADDS into. At most kControlBlock frames.
struct Buffer {
  float* left = nullptr;
  float* right = nullptr;
  int frames = 0;
  int size() const { return frames; }
  void add(int i, float mono) { left[i] += mono; right[i] += mono; }
  void add(int i, float l, float r) { left[i] += l; right[i] += r; }
};

// Linear per-sample ramp across one control block.
struct Ramp {
  float from = 0, to = 0;
  int frames = 1;
  float at(int i) const { return from + (to - from) * (static_cast<float>(i + 1) / static_cast<float>(frames)); }
};

// What a voice sees while rendering one control block.
class VoiceContext {
 public:
  float get(Param p) const { return values_[p.index]; }   // smoothed, plus this voice's modulation
  int choice(Param p) const { return static_cast<int>(values_[p.index] + 0.5f); }
  bool on(Param p) const { return values_[p.index] >= 0.5f; }
  Ramp ramp(Param p) const { return Ramp{prev_[p.index], values_[p.index], frames_}; }

  float pitchHz() const;        // tuning + bend + glide + unison detune
  double pitch() const;         // same, as a fractional MIDI note
  int key() const;              // the MIDI note that started this voice
  float velocity() const;       // 0…1
  int channel() const;
  bool released() const;        // key up (after sustain pedal)
  bool legato() const;          // last start() was a legato transition

  float env(int n) const;               // standard envelope n (1-based), block start
  const float* envSamples(int n) const; // per-sample values for this block
  int unisonIndex() const;
  int unisonCount() const;
  dsp::Rng& rng() const;                // per-voice, reseeded each note

  float modwheel() const;
  float aftertouch() const;             // max of channel and poly pressure
  float bend() const;                   // -1…1
  float cc(int n) const;                // last value of any CC, 0…1
  Beats noteAge() const;                // beats since the note started

  // Modulation (API.md §6). Values are this voice's, for this block.
  float lfo(int n) const;               // standard LFO n (1-based), -1…1 × depth
  float shape(int n) const;             // shape n (1-based), 0…1 × depth
  float source(ModSource s) const;      // a custom source
  void setSource(ModSource s, float v); // per-voice custom source, used from the next block

  const Transport& transport() const;
  double sampleRate() const;
  int frames() const { return frames_; }

 private:
  friend struct detail::Core;
  const float* values_ = nullptr;
  const float* prev_ = nullptr;
  int frames_ = 0;
  detail::Core* core_ = nullptr;
  detail::Slot* slot_ = nullptr;
};

// What processGlobal sees.
class GlobalContext {
 public:
  float get(Param p) const { return values_[p.index]; }
  int choice(Param p) const { return static_cast<int>(values_[p.index] + 0.5f); }
  bool on(Param p) const { return values_[p.index] >= 0.5f; }
  Ramp ramp(Param p) const { return Ramp{prev_[p.index], values_[p.index], frames_}; }
  float modwheel() const;
  float cc(int n) const;
  int activeVoices() const;
  float lfo(int n) const;               // global LFO value (per-voice LFOs read 0 here)
  float shape(int n) const;
  void setSource(ModSource s, float v); // global value of a custom source
  const Transport& transport() const;
  double sampleRate() const;
  int frames() const { return frames_; }

 private:
  friend struct detail::Core;
  const float* values_ = nullptr;
  const float* prev_ = nullptr;
  int frames_ = 0;
  detail::Core* core_ = nullptr;
};

// How a voice is being started.
struct StartInfo {
  bool legato = false;    // mono/legato transition: don't retrigger anything
  bool sounding = false;  // the voice was still making sound (mono retrigger,
                          // steal): avoid resets that would click
};

struct NoteContext {
  int note;
  float velocity;
  int channel;
  dsp::Rng& rng;  // seeded per note
  const Transport& transport;
};

// The event stage (API.md §4a).
class EventContext {
 public:
  struct Range {
    const MidiEvent* b; const MidiEvent* e;
    const MidiEvent* begin() const { return b; }
    const MidiEvent* end() const { return e; }
    std::size_t size() const { return static_cast<std::size_t>(e - b); }
  };
  Range in() const;
  void out(const MidiEvent& e);                         // at e.sample (or block start)
  bool schedule(Beats beat, const MidiEvent& e, uint32_t tag = 0);  // false if queue full
  void cancel(uint32_t tag);                            // drops pending; note-offs fire now
  Beats quantize(Beats beat, Division d) const { return quantizeUp(beat, d, transport()); }
  Beats now() const;                                    // beat at block start
  Beats blockEnd() const;
  Beats seconds(double s) const { return transport().seconds(s); }
  dsp::Rng rng(const MidiEvent& e, bool perKey = false);  // perKey: same stream every time
  const Transport& transport() const;
  float get(Param p) const;
  int choice(Param p) const { return static_cast<int>(get(p) + 0.5f); }
  bool on(Param p) const { return get(p) >= 0.5f; }
  double sampleRate() const;
  int pending() const;                                  // queued events
  void trigger(int shape);                              // restart shape n (1-based) now
  void setSource(ModSource s, float v);                 // global value of a custom source

 private:
  friend struct detail::Core;
  friend class Synth;
  detail::Core* core_ = nullptr;
};

// Voice slots, for custom allocation policies.
class VoicePool {
 public:
  enum class State { Free, Held, Released, Fading };
  int size() const;
  int limit() const;            // polyphony (non-fading voices allowed)
  int activeCount() const;      // held + released
  State state(int i) const;
  int note(int i) const;
  uint64_t age(int i) const;    // larger = started more recently
  float level(int i) const;     // recent peak output
  int findFree() const;         // -1 if none
  void fadeOut(int i);          // quick click-free fade, then free
  int defaultAllocate(const NoteOn& n);  // the kit's policy (see API.md)

 private:
  friend struct detail::Core;
  detail::Core* core_ = nullptr;
};

class Voice {
 public:
  virtual ~Voice() = default;
  virtual void prepare(const PrepareInfo&) {}
  virtual void start(const NoteOn& n, const StartInfo& s) = 0;
  virtual void release() {}
  virtual void render(VoiceContext& ctx, Buffer& out) = 0;  // ADD into out
  // Return false when the voice has finished sounding. With the kit's amp
  // envelope (features.ampEnv, default on) the kit also frees the voice when
  // env1 ends, so most voices don't need to override this.
  virtual bool active() const { return true; }

 protected:
  // Per-voice random stream, reseeded (deterministically) before each start().
  // Same stream as VoiceContext::rng().
  dsp::Rng& rng() { return *rng_; }

 private:
  friend struct detail::Core;
  dsp::Rng* rng_ = nullptr;
};

class Synth {
 public:
  virtual ~Synth() = default;

  virtual void defineParams(ParamBuilder& b) = 0;
  virtual void defineCustom(CustomBuilder&) {}
  virtual void defineModSources(ModSourceBuilder&) {}
  virtual std::unique_ptr<Voice> makeVoice() = 0;

  virtual void prepare(const PrepareInfo&) {}
  virtual void processEvents(EventContext& ctx) {
    for (auto& e : ctx.in()) ctx.out(e);
  }
  virtual void processGlobal(GlobalContext&, Buffer&) {}
  virtual double tune(int note, const NoteContext&) { return note; }
  virtual int allocateVoice(const NoteOn& n, VoicePool& pool) { return pool.defaultAllocate(n); }
  virtual void onTransportJump(EventContext& ctx);  // default: flush pending events
  virtual void migratePatch(int /*fromVersion*/, PatchData&) {}
};

}  // namespace sk

// In exactly one .cpp of a synth: SK_SYNTH(MySynth)
#define SK_SYNTH(Type) \
  std::unique_ptr<::sk::Synth> sk_createSynth() { return std::make_unique<Type>(); }
