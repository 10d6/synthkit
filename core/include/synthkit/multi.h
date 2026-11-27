#pragma once

// A Multi (API.md §5b): several parts, each a whole Engine running one patch of
// the synth, played through a set of zones that decide which keys, velocities
// and MIDI channels reach which part. Splits, layers and velocity layers are
// all zones; so is a channel-per-part multitimbral setup.

#include <array>
#include <atomic>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "engine.h"

namespace sk {

constexpr int kMaxParts = 8;
constexpr int kMaxZones = 64;

// One rule: notes inside these ranges play `part`. Like an SFZ region or an
// Ableton rack zone: ranges are inclusive, and a note can match several zones
// (layers) or none.
struct Zone {
  int part = 0;                       // 0…parts-1
  int keyLo = 0, keyHi = 127;
  int velLo = 1, velHi = 127;         // 1…127
  // Crossfades, in notes / velocity steps, inside the range: the zone rises
  // from nearly silent at its low edge to full level `fadeIn` steps above it,
  // and the same down to the high edge. Two zones whose fades overlap
  // crossfade: fade a lower zone out by n over the n top notes of its range,
  // and the upper zone in by n starting at the same note.
  int keyFadeIn = 0, keyFadeOut = 0;
  int velFadeIn = 0, velFadeOut = 0;
  bool linearFade = false;            // false: equal power (the sum of squares stays 1)
  int channel = -1;                   // only this input MIDI channel (0…15); -1 = any
  int transpose = 0;                  // semitones, applied to the note the part plays
  float gainDb = 0;                   // on top of the fades (-120…+12)
};

// A part's level, pan, transpose and scale are its patch's (master, sk.pan,
// sk.transpose, sk.scale, sk.scaleKey: API.md §3), so they go with the patch.
struct PartSettings {
  bool mute = false, solo = false;
};

// The scales a patch can be kept in (sk.scale: the sequencer's list; 0 is Chromatic).
int multiScaleCount();
const char* multiScaleName(int index);
int multiScaleIndex(const std::string& name);   // -1 if there's no such scale
// Where `note` goes in that scale and key (the nearest scale note, ties down).
int multiScaleSnap(int note, int scale, int scaleKey);

// Everything about a multi except the patches themselves.
struct MultiLayout {
  int parts = 1;                      // parts in use, 1…maxParts (the rest are idle)
  std::array<PartSettings, kMaxParts> part{};
  std::vector<Zone> zones;            // at most kMaxZones
};

class Multi {
 public:
  using EngineFactory = std::function<std::unique_ptr<Engine>()>;
  // Finds a preset by key ("pads/warm"); false if there is none.
  using PresetResolver = std::function<bool(const std::string& key, Json& patch)>;

  // Makes `maxParts` engines of one synth. Needs info().features.multi.
  explicit Multi(const EngineFactory& make, int maxParts = kMaxParts);
  ~Multi();
  Multi(const Multi&) = delete;
  Multi& operator=(const Multi&) = delete;

  const SynthInfo& info() const;
  int maxParts() const;
  Engine& part(int index);                // 0…maxParts-1, for patches, params and state
  const Engine& part(int index) const;

  void prepare(double sampleRate, int maxBlock);
  void releaseResources();

  // Events must be sorted by sample offset. outs: 1 (mono) or 2 channels.
  void process(float* const* outs, int numOutputs, int frames,
               const MidiEvent* events, int numEvents, const HostTransport& transport);

  void allNotesOff();  // thread-safe request, handled at the next block
  void panic();

  // The layout. Safe to change while playing: the audio thread picks the new
  // one up at the next block. A note keeps going to the parts it started on
  // until it's released, whatever the zones say now. One control thread.
  // Returns warnings for what had to be corrected.
  std::vector<std::string> setLayout(const MultiLayout& layout);
  const MultiLayout& layout() const;

  // Presets named in a multi's parts ("preset": "pads/warm") come from here.
  void setPresetResolver(PresetResolver r);

  // Just the layout as JSON, `{"parts":[{mute, solo}…], "zones":[…], "ui":{…}}`
  // in the form save() uses, for a page or plugin that edits it. setLayoutJson
  // is setLayout() from that form; fields left out take their defaults, and a
  // missing "zones" is one zone per part (every part plays every key). "ui" is
  // the page's own state for this multi (any object, kept as it is; left out,
  // the current one stays).
  Json layoutJson() const;
  std::vector<std::string> setLayoutJson(const Json& layout);

  // The multi as JSON ("format": "sk.multi"): the layout and every part's
  // patch (as the part is right now). Loading sets all the patches and the
  // layout; parts the multi doesn't use go back to the synth's default.
  Json save(const std::string& name = std::string()) const;
  LoadResult load(const Json& multi);

  // Largest figures since the last call, summed voices.
  EngineStats takeStats();

  // Diagnostics (API.md §10a), any thread but the audio thread:
  // {"router": {represses, doubled, events}, "parts": [{"part": i,
  // …Engine::diagnostics()}]} for the parts in use. The router deals with a
  // key pressed again while held before the parts see it (they get its
  // note-off, then the note-on), so its findings are here.
  Json diagnostics() const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

// From the build, like makeEngine(): a Multi of the embedded synth, whose
// factory presets can be named in a multi's parts. Needs features.multi.
std::unique_ptr<Multi> makeMulti();

// The zone fade: how loud a note is, 0…1, at `pos` in a range [lo, hi] whose
// edges fade in over `in` and out over `out` steps. Public so a page's zone
// editor can draw the same curve.
float zoneFade(int pos, int lo, int hi, int in, int out, bool linear);

}  // namespace sk
