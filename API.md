# synthkit API

> **Status: v0.1.** Sections marked **✓** are implemented (phase 2). The
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
  ui/layout.json       which controls go where (phase 3)
  ui/custom.js         optional: custom widgets (phase 3)
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
§10) and a CTest test that runs every check. Later phases add the web and
plugin targets to the same call.

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
| `standardLfos`, `modSlots`, `shapes` | 0 | phase 4 (§6) |

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
| `modulatable()` | Appears as a mod matrix destination (phase 4). |
| `smoothing(ms)` | Default 10 ms for floats, 0 for choices/toggles/integers. |
| `group(s)` | Groups params in the host's list. |
| `hidden()` | Saved in patches, not shown to the host. |

Mistakes (duplicate IDs, reserved IDs, `log()` on a range through zero) throw
when the synth is created, so they show up in the first test run.

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
  float fc = ctx.get(synth.cutoff);    // smoothed (+ this voice's modulation, phase 4)
  osc.setFreq(ctx.pitchHz());          // tuning + bend + glide + unison detune
  filter.set(fc, ctx.get(synth.reso));
  for (int i = 0; i < out.frames; ++i) out.add(i, filter.process(osc.next()));
}
```

| `VoiceContext` | |
|---|---|
| `get(p)`, `choice(p)`, `on(p)` | parameter value (float, choice index, toggle) |
| `ramp(p)` | `.at(i)` gives a per-sample ramp across this block, for zipper-free gain |
| `pitchHz()`, `pitch()` | current pitch in Hz / as a fractional MIDI note |
| `key()`, `velocity()`, `channel()` | the note that started the voice |
| `released()`, `legato()` | key is up; last start was legato |
| `env(n)`, `envSamples(n)` | standard envelope n (1-based): block-start value / per-sample array |
| `unisonIndex()`, `unisonCount()` | this voice's unison layer |
| `rng()` | per-voice random stream (same as `rng()` in `start`) |
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
| `ctx.trigger(shape, e)` | start a shape (phase 4, §6a) |
| `ctx.setSource(src, v)` | drive a custom mod source (phase 4) |

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
exceptions. Allocate in `prepare`. Use `dsp::Rng` for randomness (seedable,
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
- `"mod"` and `"shapes"` are preserved through load and save now, and used from
  phase 4.

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
- `sk::Json` is a small JSON value: `j["key"]`, `j[i]`, `number()`,
  `string()`, `boolean()`, `items()`, `members()`, `to(array)`, and assignment
  from numbers, strings, `std::array` and `std::vector`. Missing keys read as
  null, never throw.
- Custom state isn't automatable or modulatable. If one element needs that,
  promote it to a parameter (`ParamArray` covers per-pitch-class cases).
- The UI edits it through custom widgets (§9): `ctx.custom("keys")`,
  `ctx.setCustom("keys", value)`, `ctx.onCustom("keys", fn)`.
- `migratePatch` (above) can rewrite `"custom"` too.

## 6. Modulation (phase 4)

**Sources** provided by the kit: `env1`, `env2`, `lfo1`, `lfo2`, `shape1`…
(§6a), `velocity`, `key` (key tracking, 0 at C4), `modwheel`, `aftertouch`,
`bend`, `random` (new value per note), `const` (fixed 1.0, for offsets via
`via`).

**Musical-time sources** (global, follow the transport):

| Source | Value |
|---|---|
| `beat.phase` | 0→1 ramp over each beat |
| `bar.phase` | 0→1 ramp over each bar (respects time signature) |
| `bar.beat` | which beat of the bar, 0→1 across the bar's beats, stepped |
| `downbeat` | 1 on the first beat of a bar, 0 otherwise |
| `note.age` | per voice: beats since this note started, 0→1 over `note.ageSpan` |
| `note.offbeat` | per voice: how far the note started from the nearest beat (−1…1) |

Combined with `via`, these let you do things like "velocity sets how hard the
bar's downbeat accents the filter".

**Matrix:** `modSlots` routes, each `src → dst × amt`, optional `via` (a second
source that scales the amount). `amt` is −1…1 of the destination's full
normalised range. Per-voice sources (envelopes, velocity, key, random) give
per-voice modulation; global ones (LFOs in global mode, modwheel) are shared.

**Custom sources:** a synth can publish its own.

```cpp
void defineModSources(ModSourceBuilder& b) override {
  phraseStep = b.add("phrase.step").name("Phrase Step").perVoice().unipolar();
}
// in render: ctx.setSource(synth.phraseStep, value01);
```

Custom sources show up in the matrix like built-ins.

## 6a. Shapes: drawn, tempo-locked modulation (phase 4)

A shape is a curve you draw (breakpoints with adjustable curvature, or steps),
like an automation lane, that a note or the bar line plays back. It's a mod
source, so it can drive anything the matrix reaches. Example: an organ
"pedal pump" curve, one bar long, restarting on each note and pushing
amplitude and brightness.

`features.shapes: 4` adds `shape1`…`shape4`. Any number works; raising it
later is safe for existing patches and projects, lowering it isn't (patches
using the removed shapes lose them). Each shape gets these parameters (so
they're automatable and modulatable themselves):

| Param | Options |
|---|---|
| `shapeN.length` | in beats/bars (`1/16` … `8 bars`, triplet/dotted) or seconds |
| `shapeN.trigger` | `note` (per voice), `firstNote` (global, restarts when all keys were up), `bar`, `beat`, `free` (continuous, transport-locked) |
| `shapeN.start` | `immediate`, or quantised to the next `1/16` … `bar` |
| `shapeN.loop` | `once`, `loop`, `whileHeld`, `pingPong`, `releaseSegment` (jumps to a tail on key up) |
| `shapeN.rate` | playback speed multiplier (modulatable, e.g. by velocity) |
| `shapeN.offset` | phase offset 0…1 (modulatable, e.g. by key) |
| `shapeN.depth` | output scale |
| `shapeN.smooth` | slew, for removing steps |
| `shapeN.keys` / `shapeN.vel` | ranges that may trigger it (e.g. only keys below C3) |

- The curve itself is stored in the patch under `"shapes"` (it's bulk data,
  not a parameter). A shape can have several stored curves and a `shapeN.curve`
  param to switch between them, so the curve choice itself is automatable.
- The editor (`{ "kit": "shape1" }` in the layout) snaps to a grid drawn from
  the current time signature, with draw, step, and curve-bend tools.
- `processEvents` can also start a shape directly: `ctx.trigger(shape, e)`, so a
  synth can decide in code which notes fire it.
- Synths can read a shape directly: `ctx.shape(synth.pump)` for logic that
  doesn't fit the matrix.

## 7. Tempo ✓ (LFO sync: phase 4)

`ctx.transport()` → `Transport { bpm, playing, beat, barStart, timeSigNum,
timeSigDen }`, plus `beatsPerBar()`, `secondsPerBeat()` and `seconds(s)`. In the
plugin this comes from the host. In the browser it comes from incoming MIDI
clock if present, otherwise the shell's internal clock (BPM control in the
toolbar). `beat` keeps advancing when the transport is stopped (§4a).

Synced values use `sk::Division`: `Division::Whole`, `Half`, `Quarter`,
`Eighth`, `Sixteenth`, `ThirtySecond` and `Bar`, with `.triplet()` and
`.dotted()`. `d.length(transport)` gives beats. `Division::parse("1/8T", d)`
and `d.name()` convert to and from text. Standard LFOs will have this built in
(`lfo1.sync`, phase 4).

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

## 9. UI layout (phase 3)

```json
{
  "size": [960, 560],
  "theme": { "accent": "#e8a33d" },
  "header": { "presetBar": true, "bpm": true, "scope": true },
  "sections": [
    { "title": "Oscillator", "controls": [
      { "param": "wave", "type": "segmented" },
      { "param": "drive", "type": "knob" }
    ]},
    { "title": "Filter", "controls": [
      { "param": "cutoff", "type": "knob", "size": "large" },
      { "param": "reso", "type": "knob" }
    ]},
    { "kit": "env1" }, { "kit": "lfo1" }, { "kit": "modMatrix" }
  ],
  "keyboard": true
}
```

Control types: `knob`, `slider`, `segmented`, `menu`, `toggle`, `xy`
(`params: [a, b]`). `{ "kit": … }` inserts a ready-made panel for a kit feature.
Every control gets double-click-to-reset, fine-drag with Shift, right-click
→ MIDI learn, and a modulation ring when it's a mod destination.

**Custom widgets** (`ui/custom.js`):

```js
export function register(sk) {
  sk.widget("phraseView", (el, ctx) => {
    ctx.onParam("density", v => { /* redraw */ });
    ctx.onMeter("phrase.step", v => { /* animate */ });  // from mod sources
    // ctx.set("density", 0.7) to change a value
  });
}
```
Then use `{ "type": "phraseView" }` in the layout. Custom widgets run
identically in the browser and the plugin. They can also read and edit custom
state (§5a), e.g. a 128-key detune editor drawn over a keyboard.

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

## 11. Targets

| Target | Used in | Phase |
|---|---|---|
| Web (WASM + AudioWorklet, GitHub Pages) | development, quick play | 3 |
| VST3 (Windows, macOS) | Ableton Live, Reaper | 5 |
| AU (macOS) | GarageBand, Logic, Reaper | 5 |
| CLAP | Reaper, Bitwig | optional, later |
