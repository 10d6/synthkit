#pragma once

#include <cmath>
#include <string>
#include <string_view>

#include "synthkit/midi.h"

namespace sk {

// Where the tempo comes from (API.md §7).
enum class TempoSource {
  Daw,        // the plugin's host: its tempo, time signature and position
  Browser,    // the browser page's tempo controls (and, with tempoInPatch, the patch's tempo)
  MidiClock,  // the browser page following incoming MIDI clock
  Offline,    // the render tool (a scenario's transport, or the patch's tempo)
  Own,        // no tempo information (a host without a play head): the kit's own clock
};
const char* tempoSourceName(TempoSource s);

// Musical time as the engine sees it. `beat` always advances, even when the
// host is stopped (the kit keeps its own clock at the current tempo), so
// tempo-locked behaviour works while you're just playing the keyboard.
struct Transport {
  double bpm = 120;
  bool playing = false;     // host/shell transport running
  Beats beat = 0;           // current position in quarter notes
  Beats barStart = 0;       // position of the current bar's downbeat
  int timeSigNum = 4;
  int timeSigDen = 4;
  TempoSource source = TempoSource::Own;

  double beatsPerBar() const { return timeSigNum * 4.0 / timeSigDen; }
  double secondsPerBeat() const { return 60.0 / bpm; }
  Beats seconds(double s) const { return s * bpm / 60.0; }  // seconds -> beats
};

// What an adapter (plugin host, browser shell, render tool) passes in.
struct HostTransport {
  bool valid = false;       // false: no host info; kit runs its own clock
  TempoSource source = TempoSource::Own;   // what valid info comes from
  double bpm = 120;
  bool playing = false;
  Beats beat = 0;           // position at the first sample of the block
  Beats barStart = 0;
  int timeSigNum = 4;
  int timeSigDen = 4;
};

// A note length. Beats are quarter notes; `bar` means one bar of whatever the
// current time signature is.
struct Division {
  double beats = 1;
  bool bar = false;

  constexpr Division() = default;
  constexpr explicit Division(double b, bool isBar = false) : beats(b), bar(isBar) {}

  constexpr Division triplet() const { return Division(beats * 2.0 / 3.0, bar); }
  constexpr Division dotted() const { return Division(beats * 1.5, bar); }
  double length(const Transport& t) const { return bar ? beats * t.beatsPerBar() : beats; }

  // "1/4", "1/8T", "1/16.", "1 bar", "2 bars", "3/4" …
  static bool parse(std::string_view text, Division& out);
  std::string name() const;

  static const Division Whole, Half, Quarter, Eighth, Sixteenth, ThirtySecond, Bar;
};

inline constexpr Division Division::Whole{4.0};
inline constexpr Division Division::Half{2.0};
inline constexpr Division Division::Quarter{1.0};
inline constexpr Division Division::Eighth{0.5};
inline constexpr Division Division::Sixteenth{0.25};
inline constexpr Division Division::ThirtySecond{0.125};
inline constexpr Division Division::Bar{1.0, true};

// Next grid point at or after `beat` (within a tiny tolerance).
inline Beats quantizeUp(Beats beat, Division d, const Transport& t) {
  double len = d.length(t);
  if (len <= 0) return beat;
  double origin = d.bar ? t.barStart : 0.0;
  double n = std::ceil((beat - origin) / len - 1e-9);
  return origin + n * len;
}

}  // namespace sk
