# synthkit API

> **Status: v0.3.** Sections marked **✓** are implemented (phases 2–4). The
> rest are the agreed contract for later phases (see README → Roadmap) and may
> still be refined when they're built.

This page is everything you need to build a synth on synthkit. A synth should
not need to read synthkit's source; if it does, this page is missing something.

Include `<synthkit/synth.h>`; everything is in namespace `sk` (DSP blocks in
`sk::dsp`).

---

## 1. What a synth repo contains ✓

```
my-synth/
  synthkit/            git submodule, pinned to a tag
  synth.json           identity + feature flags
  src/Synth.cpp        params, voice, optional hooks
  ui/layout.json       which controls go where (§9)
  ui/custom.js         optional: custom widgets (§9)
  presets/*.json       factory patches (embedded into the build)
  tests/*.json         render scenarios run in CI
  CMakeLists.txt
```

```cmake
cmake_minimum_required(VERSION 3.22)
project(my-synth CXX)
add_subdirectory(synthkit)
include(CTest)
synthkit_add_synth(mysynth SOURCES src/Synth.cpp)
```

`synthkit_add_synth` builds `mysynth_synth` (a library with the synth, its
`synth.json` and presets embedded), `mysynth_render` (the render/check tool,
§10) and a CTest test that runs every check. With the browser toolchain the
same call builds `<name>.html` instead (§11). Phase 5 adds the plugin targets.

Everything else (MIDI, voices, patches, mod matrix, UI binding, automation,
web build, plugin builds) comes from synthkit.

## 2. `synth.json`: identity ✓

```json
{
  "id": "aleatoric",
  "name": "Aleatoric",
  "vendor": "10d6",
  "version": "0.1.0",
  "pluginCode": "Alea",
  "vendorCode": "Tend",
  "patchVersion": 1,
  "features": {
    "voices": 16,
    "voiceModes": ["poly", "mono", "legato"],
    "unison": true,
    "standardEnvelopes": 2,
    "ampEnv": true,
    "eventQueue": 256,
    "standardLfos": 2,
    "modSlots": 8,
    "shapes": 4
  }
}
```

- `id`, `pluginCode`, `vendorCode` are **permanent**. Hosts use them to find the
  plugin in saved projects. Changing them breaks every project that uses it.
  `id` uses letters, digits, `-` and `_`.
- `pluginCode` / `vendorCode`: exactly 4 ASCII characters. `vendorCode` needs
  at least one uppercase letter. `pluginCode` should be one uppercase letter
  followed by three lowercase (`Alea`), which GarageBand requires.
- `patchVersion`: bump when a change needs migration (§5).

| Feature | Default | Meaning |
|---|---|---|
| `voices` | 8 | voice slots; **each unison layer uses one** (8 voices × unison 4 = 2 notes) |
| `voiceModes` | `["poly"]` | any of `poly`, `mono`, `legato`; more than one adds a `voiceMode` param |
| `unison` | false | adds `unison` (1–8), `unisonDetune`, `unisonSpread` |
| `standardEnvelopes` | 1 | ADSRs the kit runs per voice (`env1`, `env2`, …) |
| `ampEnv` | true | `env1` shapes every voice's output (see §4) |
| `eventQueue` | 256 | capacity for scheduled events (§4a) |
| `standardLfos` | 0 | standard LFOs (§6) |
| `modSlots` | 0 | matrix routes; also adds `sk.pitch`, `sk.level` (§6) |
| `shapes` | 0 | drawn, tempo-locked curves (§6a) |

## 3. Parameters ✓

Declared once, in code. The UI, patches, host automation, MIDI learn and the
mod matrix are all generated from this list.

```cpp
#include <synthkit/synth.h>
using namespace sk;

struct MySynth : Synth {
  Param cutoff, reso, wave, drive;

  void defineParams(ParamBuilder& b) override {
    cutoff = b.add("cutoff").name("Cutoff").range(20, 20000).log()
              .def(2000).unit("Hz").modulatable();
    reso   = b.add("reso").name("Resonance").range(0, 1).def(0.2).modulatable();
    wave   = b.add("wave").name("Wave").choices({"Saw", "Square", "Tri"});
    drive  = b.add("drive").name("Drive").range(0, 24).def(0).unit("dB")
              .smoothing(20);
  }
};
```

| Builder call | Meaning |
|---|---|
| `add(id)` | Stable string ID. **Never rename or reuse an ID.** Deleting one is fine. |
| `name(s)` | Display name; free to change. |
| `range(min, max)` | Real-world units. Call before `def`. |
| `log()` / `exp(k)` / *(default linear)* | Knob travel curve. `log` needs a positive range. |
| `def(v)` | Default, in real units. |
| `unit(s)` | Shown in UI and host. `Hz` and `s` auto-scale (`2.4 kHz`, `250 ms`). |
| `step(s)` / `integer()` | Quantise. |
| `choices({...})` | Enum parameter; value is the index. |
| `toggle()` | Boolean. |
| `modulatable()` | Appears as a mod matrix destination (§6). |
| `smoothing(ms)` | Default 10 ms for floats, 0 for choices/toggles/integers. |
| `group(s)` | Groups params in the host's list. |
| `hidden()` | Saved in patches, not shown to the host. |

Mistakes (duplicate IDs, reserved IDs, `log()` on a range through zero) are
reported when the synth is created (`sk::fail`), so they show up in the first
test run.

**Repeated parameters.** For sets like per-key or per-step controls:

```cpp
ParamArray detune;
detune = b.addArray("detune", 12).name("Detune {note}").range(-50, 50)
          .def(0).unit("ct").modulatable();     // detune.0 … detune.11
// later: ctx.get(synth.detune[pitchClass])
```

`{i}` (0-based index) and `{note}` (C, C#, …) in names are filled in per
element.

**Kit-provided parameters**, added after the synth's own, according to
`features`:

| ID | When | Range |
|---|---|---|
| `master` | always | −60…+6 dB, default 0 |
| `voiceMode` | more than one voice mode | the listed modes |
| `glide` | a mono or legato mode exists | 0…5 s |
| `bendRange` | always | 0…24 st, default 2 |
| `unison`, `unisonDetune`, `unisonSpread` | `unison: true` | 1…8; 0…100 ct; 0…1 |
| `sk.a4` | always | 400…480 Hz, default 440 |
| `envN.attack/decay/sustain/release/velocity` | per standard envelope | velocity = how much velocity scales the envelope |

Those IDs, and any ID starting with `sk.`, `env<n>.`, `lfo<n>.` or
`shape<n>.`, are reserved. Otherwise `.` is fine for grouping (`osc2.level`).

**Parameter or custom setting?** If the host should automate it, or the mod
matrix should reach it, make it a parameter. If it's bulk data (a 128-key
table, a step sequence, a sample map) or structure rather than a value, use
custom state (§5a).

## 4. Engine: voices and global processing ✓

```cpp
struct MySynth;

struct MyVoice : Voice {
  explicit MyVoice(MySynth& s) : synth(s) {}
  MySynth& synth;
  dsp::Osc osc;
  dsp::Svf filter;

  void prepare(const PrepareInfo& info) override;        // sampleRate, maxBlock
  void start(const NoteOn& n, const StartInfo& s) override;
  void release() override;                                // optional: key up (after sustain)
  void render(VoiceContext& ctx, Buffer& out) override;   // ADD into out
  bool active() const override;                           // optional: false = finished
};

struct MySynth : Synth {
  void defineParams(ParamBuilder&) override;
  std::unique_ptr<Voice> makeVoice() override { return std::make_unique<MyVoice>(*this); }

  // all optional
  void defineCustom(CustomBuilder&) override;                // §5a
  void prepare(const PrepareInfo&) override;
  void processEvents(EventContext&) override;                // §4a
  void processGlobal(GlobalContext&, Buffer& io) override;   // effects after the voices
  double tune(int note, const NoteContext&) override;        // tuning
  int allocateVoice(const NoteOn&, VoicePool&) override;     // voice allocation
  void migratePatch(int fromVersion, PatchData&) override;   // §5
};

SK_SYNTH(MySynth)   // once, in one .cpp
```

**Starting a voice.** `NoteOn` has `note`, `vel` (0…1) and `channel`.
`StartInfo` says how the voice is being started:

- `s.legato`: a legato transition. The kit isn't retriggering envelopes, and
  the voice shouldn't reset anything either.
- `s.sounding`: the voice was still making sound (a mono retrigger, or a stolen
  voice). Don't reset oscillator phases or filter state, or it will click.

Inside `start`, `rng()` gives the voice's random stream. It's reseeded per
note, deterministically, so renders repeat exactly.

**Rendering.** `render` is called once per control block of **at most 32
samples** (`kControlBlock`), and ADDS into `out` (`out.left[i]`,
`out.right[i]`, or `out.add(i, mono)`).

```cpp
void MyVoice::render(VoiceContext& ctx, Buffer& out) {
  float fc = ctx.get(synth.cutoff);    // smoothed, plus this voice's modulation
  osc.setFreq(ctx.pitchHz());          // tuning + bend + glide + unison detune
  filter.set(fc, ctx.get(synth.reso));
  for (int i = 0; i < out.frames; ++i) out.add(i, filter.process(osc.next()));
}
```

| `VoiceContext` | |
|---|---|
| `get(p)`, `choice(p)`, `on(p)` | parameter value (float, choice index, toggle), including this voice's modulation |
| `ramp(p)` | `.at(i)` gives a per-sample ramp across this block, for zipper-free gain |
| `pitchHz()`, `pitch()` | current pitch in Hz / as a fractional MIDI note |
| `key()`, `velocity()`, `channel()` | the note that started the voice |
| `released()`, `legato()` | key is up; last start was legato |
| `env(n)`, `envSamples(n)` | standard envelope n (1-based): block-start value / per-sample array |
| `unisonIndex()`, `unisonCount()` | this voice's unison layer |
| `rng()` | per-voice random stream (same as `rng()` in `start`) |
| `lfo(n)`, `shape(n)`, `source(s)`, `setSource(s, v)` | modulation sources (§6) |
| `modwheel()`, `aftertouch()`, `bend()`, `cc(n)` | controller state (aftertouch = max of channel and poly) |
| `noteAge()` | beats since the note started |
| `transport()`, `sampleRate()`, `frames()` | |

Randomness that runs every block should step on the voice's own sample count,
not once per `render` call, so the result doesn't depend on the host's block
size (the kit checks this, §10).

**What the kit does for every voice:**

- **Amplitude.** With `ampEnv` on, the kit multiplies the voice's output by
  `env1` (scaled by velocity per `env1.velocity`). The voice doesn't apply it.
- **Freeing.** A voice is freed when `env1` finishes (with `ampEnv`), when
  `active()` returns false, or when it's released and has been silent for
  50 ms.
- **Allocation and stealing.** When `voices` slots are busy, the kit steals the
  oldest released voice, otherwise the quietest held one, and fades it out over
  12 ms (stolen voices get spare slots for the fade, so the new note starts
  immediately).
- **Voice modes.** Mono and legato use last-note priority. Releasing a key
  returns to the previous held note. Mono retriggers envelopes. Legato
  retriggers only when no other key was held. `glide` applies in mono and
  legato, at a constant time per glide.
- **Unison** voices are spread across `±unisonDetune` cents and panned across
  `unisonSpread`, each at 1/√n gain.
- **MIDI.** Velocity 0 counts as note-off. CC64 is sustain. CC120 cuts all
  voices. CC123 releases all notes. Pitch bend is smoothed over ~4 ms. Every
  CC's last value is readable with `cc(n)`.
- **Output.** `master` gain, then a safety limiter (−0.3 dBFS ceiling). NaN or
  infinite samples are replaced with silence. Denormals are flushed.

**Tuning.** Notes default to 12-TET, with A4 set by `sk.a4`. To change that,
override `tune`:

```cpp
double tune(int note, const NoteContext& n) override;  // returns a fractional MIDI note
```

It's called once per note start, with `n.note`, `n.velocity`, `n.channel`,
`n.rng` (seeded per note) and `n.transport`. It can read parameters, custom
state or randomness: per-key detune tables, drifting "worn instrument"
tuning, alternate temperaments. Everything downstream (`pitchHz`, key tracking,
glide) uses the result.

**Global processing.** `processGlobal(GlobalContext& ctx, Buffer& io)` runs once
per control block after the voices are mixed, and edits `io` in place (reverb,
delay, chorus…). `GlobalContext` has `get/choice/on/ramp`, `modwheel()`,
`cc(n)`, `activeVoices()`, `transport()`, `sampleRate()`.

**Escape hatches.** The kit's defaults are meant to be overridden when a synth
needs something unusual:

- `processEvents` (§4a) → reshape, swallow or generate MIDI before voices.
- `allocateVoice(n, pool)` → return the slot index for a new note (or −1 to
  drop it). `VoicePool` has `size()`, `limit()`, `activeCount()`,
  `state(i)`, `note(i)`, `age(i)`, `level(i)`, `findFree()`, `fadeOut(i)` and
  `defaultAllocate(n)` (the policy above). Example: a fixed voice per key,
  like a piano emulation.
- `processGlobal` → anything that happens after the voices are mixed.

If an escape hatch is used in a second synth for the same reason, that's the
signal to turn it into a kit feature.

## 4a. Event processing in musical time ✓

An optional stage that sits between incoming MIDI and the voices. It sees
every event with its position in beats, and can pass it on, change it, drop it,
or schedule new events in the future, sample-accurately and locked to tempo.
The default passes everything through.

```cpp
void processEvents(EventContext& ctx) override {
  for (auto& e : ctx.in()) {
    ctx.out(e);                                            // play the key itself
    if (e.isNoteOn()) {
      Beats next = ctx.quantize(e.beat, Division::Eighth); // next 1/8 on the grid
      ctx.schedule(next + 0.5, NoteOn{e.note + 7, e.vel * 0.6f}, /*tag*/ e.note);
      ctx.schedule(next + 0.75, NoteOff{e.note + 7}, e.note);
    }
    if (e.isNoteOff()) ctx.cancel(e.note);                  // key up: drop the rest
  }
}
```

| Call | Meaning |
|---|---|
| `ctx.in()` | this block's incoming events, each with `.beat` and `.sample` |
| `ctx.out(e)` | send to the voice stage at `e.sample` (new events without one go at the block start; use `schedule(e.beat, …)` to place them exactly) |
| `ctx.schedule(beat, e, tag)` | send at a position in beats. Returns false if the queue is full. |
| `ctx.cancel(tag)` | drop pending events with that tag. Pending note-offs fire immediately, so nothing sticks. |
| `ctx.quantize(beat, div)` | next grid point at or after `beat`; `div` is a `Division`, including `Division::Bar` |
| `ctx.now()`, `ctx.blockEnd()` | beat range of this block |
| `ctx.seconds(s)` | a duration in seconds, as beats at the current tempo |
| `ctx.rng(e, perKey)` | random stream for this event; `perKey = true` gives the same stream for that key every time |
| `ctx.get(p)`, `ctx.transport()`, `ctx.sampleRate()`, `ctx.pending()` | |
| `ctx.trigger(n)` | restart shape n now (§6a) |
| `ctx.setSource(src, v)` | set a custom mod source's global value (§6) |

Events are `MidiEvent`s (`type`, `note`, `vel`, `cc`, `value`, `channel`,
`sample`, `beat`, `tag`, plus `isNoteOn()`, `isNoteOff()`, `isCC(n)`). Build
them with `NoteOn{note, vel, ch}`, `NoteOff{note, ch}`, `CC{number, value, ch}`.

- **Beats are quarter notes**, like a host's PPQ position.
- **The clock always runs.** When the host is stopped, the kit keeps counting
  beats at the current tempo, so tempo-locked behaviour works while you're just
  playing the keyboard.
- Scheduled notes go through the normal voice stage: tuning, voice allocation
  and modulation all apply. Note-offs match the oldest held note with the same
  number and channel. Use a different channel for generated notes if they
  must not collide with played keys.
- Pending events live in a fixed-size queue (`features.eventQueue`). If it
  fills, new events are dropped, except note-offs, which replace a pending
  non-note-off. Drops are counted, and the checks fail on any.
- **Transport jumps.** When the host's position jumps (looping, scrubbing,
  starting playback somewhere new), the kit calls `onTransportJump(ctx)`. By
  default it drops pending events and fires pending note-offs.
- MIDI output to the host is not planned (Live 11 handles MIDI out from
  instruments poorly).

### Real-time rules (checked by the render tool)

In `start`, `release`, `render`, `processGlobal`, `processEvents`, `tune` and
`allocateVoice`: no memory allocation, no locks, no file or console I/O, no
exceptions. (Synth code never uses exceptions at all, because the browser
build doesn't have them: §11.) Allocate in `prepare`. Use `dsp::Rng` for randomness (seedable,
allocation-free). The render tool counts every allocation made while the
engine is processing audio, and fails on any.

## 5. Patches ✓

A patch is JSON, stored in **real units** so changing a range doesn't corrupt
old patches.

```json
{
  "synthkit": 1,
  "synth": "aleatoric",
  "patchVersion": 1,
  "name": "Glass Rain",
  "author": "",
  "tags": ["pad", "bright"],
  "params": { "cutoff": 3200, "reso": 0.35, "wave": 1, "env1.attack": 0.02 },
  "custom": { "keys": { "keyDetune": [0, 3.5, -2] } },
  "mod": [
    { "src": "lfo1", "dst": "cutoff", "amt": 0.25 },
    { "src": "velocity", "dst": "reso", "amt": -0.1, "via": "modwheel" }
  ]
}
```

- On load: missing params → default; unknown params → ignored, with a warning;
  values clamped. A patch for a different `synth` is refused.
- Presets only need the params that differ from the defaults.
- When a change needs more than that (e.g. splitting one param into two), bump
  `patchVersion` in `synth.json` and implement:
  ```cpp
  void migratePatch(int fromVersion, PatchData& p) override {
    if (fromVersion < 2) p.renameParam("volume", "level");
  }
  ```
  `PatchData` has `param(id)`, `setParam`, `hasParam`, `removeParam`,
  `renameParam`, `custom(id)` and `json()` for anything else.
- Factory presets live in `presets/` and are embedded into the build. User
  presets are saved by the host shell (browser storage, or the plugin's user
  folder) and can be exported as files.
- The same JSON is what the plugin stores inside your DAW project.
- MIDI-learn mappings are **not** part of a patch; they're per-installation.
- `"mod"` holds the matrix routes (§6) and `"shapes"` the shape curves (§6a).
  A synth without those features keeps them unchanged through load and save.

## 5a. Custom state ✓

For synth-specific settings that aren't parameters. Stored in the patch under
`"custom": { "<id>": … }` and saved with the DAW project like everything else.

```cpp
struct KeyTable { std::array<float, 128> cents{}; std::string temperament; };
Custom<KeyTable> keys;   // member of the synth

void defineCustom(CustomBuilder& b) override {
  keys = b.add<KeyTable>("keys", {
    .save = [](const KeyTable& k, Json& j) { j["keyDetune"] = k.cents; j["temperament"] = k.temperament; },
    .load = [](const Json& j, KeyTable& k) { j["keyDetune"].to(k.cents); k.temperament = j["temperament"].string(); },
    .initial = {},   // optional: value for patches that don't have it
  });
}

double tune(int note, const NoteContext&) override {
  return note + keys.read().cents[note] / 100.0;   // audio-thread safe
}
```

- `read()` is lock-free and safe on the audio thread. `write(value)` and
  `modify([](KeyTable& k) { … })` are for other threads (UI, patch load). They
  build a new copy and swap it in whole, so the audio thread never sees half a
  table.
- `sk::Json` is a small JSON value: `Json::tryParse(text, out, &error)`, `j["key"]`, `j[i]`, `number()`,
  `string()`, `boolean()`, `items()`, `members()`, `to(array)`, and assignment
  from numbers, strings, `std::array` and `std::vector`. Missing keys read as
  null, never throw.
- Custom state isn't automatable or modulatable. If one element needs that,
  promote it to a parameter (`ParamArray` covers per-pitch-class cases).
- The UI edits it through custom widgets (§9): `ctx.custom("keys")`,
  `ctx.setCustom("keys", value)`, `ctx.onCustom("keys", fn)`.
- `migratePatch` (above) can rewrite `"custom"` too.

## 6. Modulation ✓

Turned on by `features`: `modSlots` (matrix routes), `standardLfos` and
`shapes` (§6a). A synth makes a parameter a destination with
`.modulatable()`.

**Sources.** Unipolar sources run 0…1; bipolar ones run −1…1.

| Source id | Value | Per voice |
|---|---|---|
| `env1`… | standard envelopes (after their velocity scaling) | ✓ |
| `lfo1`… | standard LFOs × depth, bipolar | in Per Voice mode, or with a fade-in |
| `shape1`… | shapes × depth (§6a) | when triggered by Note |
| `velocity` | note velocity | ✓ |
| `key` | (note − 60) / 60, bipolar: 0 at C4 | ✓ |
| `random` | a new value for each note, bipolar | ✓ |
| `aftertouch` | the larger of channel and poly pressure | ✓ |
| `modwheel`, `bend` | CC 1; pitch bend (bipolar) | |
| `const` | always 1, so a route adds a fixed offset (useful with `via`) | |
| `beat.phase` | 0→1 ramp over each quarter note | |
| `bar.phase` | 0→1 ramp over each bar (follows the time signature) | |
| `bar.beat` | which beat of the bar, as beat ÷ beats per bar, stepped | |
| `downbeat` | 1 during the bar's first beat, else 0 | |
| `note.age` | beats since the note started, 0→1 over `sk.ageSpan` beats (default 4) | ✓ |
| `note.offbeat` | how far the note started from the nearest beat, bipolar: ±1 is half a beat early or late | ✓ |
| custom | the synth's own, below | if declared per voice |

**Matrix.** Up to `modSlots` routes, each `src → dst × amt`, with an optional
`via` (a second source that multiplies the amount). `amt` runs −1…1 of the
destination's full knob range, in normalised (knob) units, so an amount means
the same on a log cutoff as on a linear mix. Routes to the same destination
add, and the result is clamped to the parameter's range.

**Kit destinations,** added with `modSlots`:

| ID | |
|---|---|
| `sk.pitch` | pitch offset, ±12 semitones (vibrato, pitch envelopes). Every voice's `pitch()`/`pitchHz()` includes it. |
| `sk.level` | voice level 0…1, applied by the kit after the amp envelope (tremolo, gates, pedal pumps) |
| `lfoN.rate`, `lfoN.phase`, `lfoN.depth` | LFOs modulating LFOs |
| `shapeN.rate`, `shapeN.offset`, `shapeN.depth` | |

`sk.ageSpan` (1–32 beats) sets the span of `note.age`.

**Where modulation applies.** Voices see their own modulated values through
`ctx.get()`. `processGlobal`, `processEvents` (`ctx.get`) and the master level
see *global* modulation: routes are evaluated with per-voice sources counting
as 0, and aftertouch as channel pressure. Values update once per control block
(32 samples). Use `ctx.ramp(p)` for anything that would zipper, such as
amplitude.

**Custom sources:**

```cpp
ModSource phraseStep;
void defineModSources(ModSourceBuilder& b) override {
  phraseStep = b.add("phrase.step").name("Phrase Step").perVoice();  // .bipolar() for -1…1
}
// in a voice:       ctx.setSource(synth.phraseStep, value);   (used from the next block)
// in processEvents / processGlobal:  ctx.setSource(synth.phraseStep, value);  (global value)
```

Custom sources show up in the matrix and in custom widgets (`ctx.onMeter`)
like the built-in ones. A per-voice source that a voice hasn't set uses the
global value.

**Reading modulation directly.** In a voice, `ctx.lfo(n)`, `ctx.shape(n)` and
`ctx.source(src)` give this voice's values. In `processGlobal`, `ctx.lfo(n)`
and `ctx.shape(n)` give the global ones. This is for logic that doesn't fit the
matrix.

**Standard LFOs** (`standardLfos: 2` adds `lfo1`, `lfo2`):

| Param | |
|---|---|
| `lfoN.shape` | Sine, Triangle, Saw Up, Saw Down, Square, S&H, Drift (smooth random) |
| `lfoN.rate` | 0.01–40 Hz, when not synced |
| `lfoN.sync`, `lfoN.division` | lock to the beat: 8 bars … 1/32, with dotted and triplet values. A synced global LFO's phase comes from the song position, so it lines up with the bar whenever notes start. |
| `lfoN.mode` | Global (one LFO shared by all voices) or Per Voice (restarts with each note) |
| `lfoN.phase` | phase offset / start phase |
| `lfoN.depth` | output scale |
| `lfoN.fade` | per-voice fade-in after each note (classic delayed vibrato) |

The patch stores routes as `"mod": [{ "src", "dst", "amt", "via"? }]`.
Unknown sources and non-modulatable destinations are dropped with a warning.

## 6a. Shapes: drawn, tempo-locked modulation ✓

A shape is a curve you draw (points with adjustable curvature, or steps),
like an automation lane, that a note or the bar line plays back. It's a mod
source, so it can drive anything the matrix reaches. Example: an organ
"pedal pump" curve, one bar long, restarting with each new phrase and
pushing voice level and brightness (the example synth's *Pedal Pump* preset).

`features.shapes: 4` adds `shape1`…`shape4`. Raising the count later is safe
for existing patches and projects; lowering it isn't (patches using the
removed shapes lose them). Each shape has these parameters, so they're
automatable, and rate, offset and depth are modulatable too:

| Param | Options |
|---|---|
| `shapeN.length` | 16 bars … 1/16 (with dotted and triplet values), when `sync` is on |
| `shapeN.sync`, `shapeN.time` | off: the length is `time` seconds (0.01–30) instead |
| `shapeN.trigger` | **Note** (per voice), **First Note** (global, restarts when a note starts with no other key held), **Bar**, **Beat** (restarts every bar or beat), **Free** (runs continuously, locked to song position), **Manual** (only `ctx.trigger`) |
| `shapeN.start` | Immediately, or wait for the next 1/16, 1/8, 1/4 or bar (for Note, First Note and Manual) |
| `shapeN.loop` | **Once** (holds the end), **Loop**, **While Held** (loops while the key is down, then finishes the cycle), **Ping-Pong**, **Release** (plays to the curve's release point and holds there, then plays the tail on key up) |
| `shapeN.rate` | playback speed, 0.25–4× |
| `shapeN.offset` | phase offset 0…1 |
| `shapeN.depth` | output scale |
| `shapeN.smooth` | slew, for softening steps |
| `shapeN.keyLow/keyHigh`, `shapeN.velLow/velHigh` | which notes may trigger it (Note and First Note) |
| `shapeN.curve` | which of up to 8 stored curves plays (so curve changes can be automated) |

- The curves are stored in the patch under `"shapes"`, one entry per shape:
  ```json
  "shapes": [ { "curves": [ { "points": [[0, 0, 0, 0,  0.2, 0, 0, 0, 0], [0.5, 1, 0, 1], [1, 0, 0, 0,  0, 0, -0.1, 0.3, 1]], "release": 0.5 } ] } ]
  ```
  Each point is `[x 0…1, y 0…1, curvature, step, outX, outY, inX, inY, corner]`:
  - **Handles** (`outX, outY` / `inX, inY`) are offsets from the point. The out
    handle shapes the segment after the point, and the in handle the one
    before it. A segment with a handle at either end is a cubic Bezier. Each
    handle reaches at most half the segment's width, so a curve can never bend
    back in time. `corner` 1 means the two handles move independently in the
    editor. The editor keeps handle ends within heights 0…1 (the curve's own
    range); a handle outside that still plays as saved and is shown pinned to
    the editor's edge until it's dragged.
  - **Step** holds the point's level until the next point.
  - Points with only the first four entries use the older **curvature** model
    (−1…1 bends the segment that starts at the point). They still load and play
    unchanged. The editor converts a curve to handles the first time it's
    edited, choosing the closest fit whose handles stay inside the editor.

  Curves always span 0…1 (missing ends are added) and hold up to 64 points.
- The editor (`{ "kit": "shape1" }` in the layout) draws a grid from the length
  and time signature and snaps to sixteenths (Shift places freely):
  - **Points:** click a point to show its handles and drag them to curve the
    lines on either side. Smooth points' handles move together; Alt/Option-drag
    moves one alone. Double-click (or double-tap) adds or removes a point.
    Right-click a point for smooth, corner, straight lines, step or delete.
    Keys: `,` and `.` select, arrows move, `S` smooths, `H` makes a step,
    Delete removes.
  - **Steps:** paints step levels.
  - **Curves…:** ready-made shapes, random steps and the release point.

  A playhead shows the most recent voice's position while notes are sounding.
- `processEvents` can start a shape itself: `ctx.trigger(n)` restarts shape `n`
  (1-based) now, for its global instance and every held voice. This is the way
  to decide in code which notes fire it.

## 7. Tempo ✓

`ctx.transport()` → `Transport { bpm, playing, beat, barStart, timeSigNum,
timeSigDen }`, plus `beatsPerBar()`, `secondsPerBeat()` and `seconds(s)`. In the
plugin this comes from the host. In the browser it comes from the page's tempo
clock (Play, BPM and time signature by the keyboard), or follows incoming
**MIDI clock** (choose *MIDI clock* next to the time signature): start, stop,
continue and song position are followed, and tempo is measured from the clock.
`beat` keeps advancing when the transport is stopped (§4a).

Synced values use `sk::Division`: `Division::Whole`, `Half`, `Quarter`,
`Eighth`, `Sixteenth`, `ThirtySecond` and `Bar`, with `.triplet()` and
`.dotted()`. `d.length(transport)` gives beats. `Division::parse("1/8T", d)`
and `d.name()` convert to and from text.

## 8. DSP building blocks ✓

All in `sk::dsp`, header-only, allocation-free after `prepare`.

| Block | Notes |
|---|---|
| `Osc` | sine, saw, square/pulse (`setPulseWidth`), triangle. Band-limited (PolyBLEP/BLAMP): aliasing ≤ −46 dBc at 3 kHz. `reset(phase)` |
| `Noise` | `white()`, `pink()`; `seed()` it from `rng()` so voices differ |
| `Svf` | state-variable filter (LP/HP/BP/notch), stable under fast modulation; `set(hz, res)` per sample is fine |
| `Ladder` | 4-pole low-pass, `set(hz, res, drive)`; self-oscillates at res 1 |
| `OnePole` | one-pole low/high-pass for tone controls and DC blocking |
| `Adsr` | linear attack from the current level (no clicks on retrigger); decay/release exponential (straight lines in dB) |
| `Lfo` | sine/tri/saw/square/S&H; `setRate(hz)` + `advance(n)`, or `syncTo(beat, periodBeats)` |
| `Smoother` | one-pole smoothing: `next()` per sample or `advance(n)` per block |
| `Delay` | fractional delay line with cubic interpolation; size in `prepare` |
| `Rng` | seedable: `uniform()`, `uniform(a,b)`, `bipolar()`, `integer(lo,hi)`, `chance(p)`, `normal()`, `pick({weights})` |
| `Limiter` | the kit already applies one before output |
| `softclip`, `mtof`, `ftom`, `dbToGain`, `gainToDb`, `panGains`, `hashSeed` | helpers |

New blocks are added to the kit when a second synth needs them; until then they
live in the synth repo.

## 9. UI layout ✓

`ui/layout.json` arranges the synth's panel. It's optional: without it, the
kit builds one section per parameter `group`, followed by the voice, envelope
and output panels.

```json
{
  "theme": { "accent": "#2457d6" },
  "sections": [
    { "title": "Oscillator", "controls": [
      { "param": "wave", "label": "Wave" },
      { "param": "drive", "type": "slider" }
    ]},
    { "title": "Filter", "controls": [
      { "param": "cutoff", "size": "large" },
      { "param": "reso", "label": "Resonance" },
      { "type": "xy", "params": ["cutoff", "reso"] }
    ]},
    { "kit": "env1" }, { "kit": "env2", "title": "Filter envelope" },
    { "kit": "voices" }, { "kit": "master" }
  ],
  "keyboard": true
}
```

| Control field | |
|---|---|
| `param` | parameter ID |
| `type` | `knob` (floats, default), `slider`, `segmented` (choices with up to 4 options, default), `menu` (longer choices), `toggle` (toggles, default), `xy` (with `params: [x, y]`), or a custom widget name |
| `label` | text under the control (default: the parameter's name) |
| `size` | `small` or `large` knob |

| Section field | |
|---|---|
| `title`, `controls` | a panel of controls |
| `kit` | a ready-made panel: `env1`, `env2`, … (with a live envelope drawing), `lfo1`, … (with a live preview), `shape1`, … (the curve editor), `modMatrix`, `voices` (mode, glide, unison, bend range), `master` (level, A4) |
| `wide` | `true` makes the panel take a full row |

- `theme.accent` colours the controls. Dark mode derives a lighter shade
  from it automatically.
- Parameters the layout doesn't mention (other than kit and hidden ones) get a
  "More" panel, so nothing is unreachable. Mistakes in the layout (unknown
  parameter IDs or control types) show as warnings when the page opens.
- Every control supports dragging (Shift for fine), the mouse wheel, arrow keys
  when focused, double-click to reset, clicking the value to type one, and
  right-click for MIDI learn, reset and **Modulate…** (adds a matrix route from
  any source). Modulated knobs show a live outer ring for the most recent
  voice.

**Custom widgets** (`ui/custom.js`): a plain script with no imports that
defines `register`:

```js
export function register(sk) {
  sk.widget("phraseView", (el, ctx) => {
    ctx.onParam("density", (v) => { /* redraw; also called once immediately */ });
    ctx.onCustom("keys", (table) => { /* custom state (§5a) as JSON */ });
    // ctx.get(id), ctx.set(id, value), ctx.format(id, value), ctx.param(id)
    // ctx.custom(id), ctx.setCustom(id, json)
    // ctx.noteOn(note, vel), ctx.noteOff(note)
    // ctx.onMeter(sourceId, fn)    live value of any mod source (~30 times a second)
  });
}
```

Then use `{ "type": "phraseView" }` as a control in the layout. Custom widgets
run identically in the browser and the plugin. A 128-key detune editor drawn
over a keyboard is the kind of thing they're for.

## 10. Testing a synth ✓

Scenarios in `tests/*.json` render offline and are checked in CI:

```json
{
  "patch": "init",
  "params": { "filter.cutoff": 800 },
  "transport": { "bpm": 96, "timeSig": [3, 4], "playing": true },
  "events": [
    { "t": 0.0, "on": 60, "vel": 100 },
    { "beat": 1, "on": 64, "vel": 60 },
    { "t": 1.5, "off": 60 }, { "t": 1.5, "off": 64 },
    { "t": 0.5, "cc": 1, "value": 90 }, { "t": 0.7, "bend": 0.5 }
  ],
  "length": 3.0,
  "expect": {
    "soundBy": 0.05,
    "silentAfter": 2.8,
    "peakBelow": -3,
    "levelAt": [ { "beat": 1.02, "above": -40 }, { "t": 2.0, "below": -60 } ]
  }
}
```

| Field | |
|---|---|
| `patch` | preset name (`"init"`), a path in the synth repo, or an inline patch object |
| `params`, `custom` | overrides applied after the patch |
| `transport` | `bpm` (120), `timeSig` (`[4, 4]`), `playing` (false) |
| `sampleRate` | default 48000 |
| `length` / `lengthBeats` | how long to render |
| `events` | time in seconds (`t`) or beats (`beat`); `on`/`off` (+`vel` 0–127, `ch`), `cc` + `value` (0–127), `bend` (−1…1), `at` (0–127) |

| Expectation | Passes when |
|---|---|
| `soundBy: t` | output exceeds −60 dBFS before `t` |
| `silentAfter: t` | output stays below −80 dBFS after `t` |
| `peakBelow: dB` | peak before the safety limiter is below `dB` |
| `limiterBelow: dB` | the limiter never reduces more than `dB` |
| `levelAt: [...]` | 20 ms RMS (or `window`) at `t`/`beat` is `above`/`below` a level |

Every scenario also fails on NaN/inf output, on any allocation on the audio
thread, and on dropped events.

**Generic checks** run on every synth, with no scenario needed:

- every preset loads without warnings and survives a save/load round trip
- every preset renders at 44.1, 48 and 96 kHz, is audible, and goes silent
  after all-notes-off (it warns when the safety limiter has to engage)
- rendering in blocks of 512, 1, 37 and 4096 samples gives the same loudness
- 25 random patches are finite, allocation-free and end in silence
- speed, reported as a multiple of realtime

**Commands** (built as `<name>_render`):

```
basic_render --check examples/basic --out renders   # everything above; WAVs into renders/
basic_render examples/basic/tests/chord.json --out chord.wav [--sr 96000] [--block 64]
basic_render --params                                # list every parameter
```

CI runs `--check` on every PR and attaches the rendered WAVs.

## 11. The browser build ✓

```
cmake -S . -B build-web -G Ninja -DCMAKE_TOOLCHAIN_FILE=synthkit/cmake/wasm32-wasi.cmake
cmake --build build-web          # → build-web/web/<name>.html
```

This needs clang 18+, `lld` and the wasm32 sysroot. On Ubuntu 24.04:
`wasi-libc libc++-18-dev-wasm32 libclang-rt-18-dev-wasm32 lld-18`. CI
installs them.

The result is **one self-contained HTML file** with the synth (WebAssembly),
the UI, the layout and the presets inside. It runs from a double-click
(`file://`), from GitHub Pages, or from anywhere else, with no server. The page
has the preset bar (factory presets, your own presets saved in the browser,
import and export as files), a keyboard you can play with the mouse, touch or
computer keys, pitch and mod wheels, Web MIDI input with MIDI learn, a tempo
clock (play, BPM, time signature), a scope, a level meter and a voice count. The
current sound is restored when you come back.

The audio engine is the same C++ as the plugin's, so the browser plays exactly
what the plugin will. CI renders a scenario through the page's real
AudioWorklet and fails if it differs from the native render by more than
floating-point noise.

**Rules this adds for synth code:** it must compile without C++ exceptions
(no `throw`, `try` or `catch`) and without threads. Report definition-time
mistakes with `sk::fail("message")`, which throws in native builds and stops
with the message in the browser.

## 12. Targets

| Target | Used in | Phase |
|---|---|---|
| Web (WASM + AudioWorklet, single HTML file) ✓ | development, quick play | 3 |
| VST3 (Windows, macOS) | Ableton Live, Reaper | 5 |
| AU (macOS) | GarageBand, Logic, Reaper | 5 |
| CLAP | Reaper, Bitwig | optional, later |
