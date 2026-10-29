# synthkit API

> **Status: draft v0.** Nothing here is implemented yet. This is the contract we
> are agreeing on before building. Each section is marked with the build phase
> that delivers it (see README → Roadmap).

This page is everything you need to build a synth on synthkit. A synth should
not need to read synthkit's source; if it does, this page is missing something.

---

## 1. What a synth repo contains

```
my-synth/
  synthkit/            git submodule, pinned to a tag
  synth.json           identity + feature flags
  src/Synth.cpp        params, voice, optional global processing
  ui/layout.json       which controls go where
  ui/custom.js         optional: custom widgets
  presets/*.json       factory patches
  tests/*.json         render scenarios run in CI
  CMakeLists.txt       ~3 lines; includes synthkit
```

Everything else (MIDI, voices, patches, mod matrix, UI binding, automation,
web build, plugin builds) comes from synthkit.

## 2. `synth.json` — identity (phase 2)

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
    "voices": 8,
    "voiceModes": ["poly", "mono", "legato"],
    "unison": true,
    "standardEnvelopes": 2,
    "standardLfos": 2,
    "modSlots": 8
  }
}
```

- `id`, `pluginCode`, `vendorCode` are **permanent**. Hosts use them to find the
  plugin in saved projects. Changing them breaks every project that uses it.
- `pluginCode` / `vendorCode`: exactly 4 ASCII characters. `vendorCode` needs
  at least one uppercase letter. `pluginCode` should be one uppercase letter
  followed by three lowercase (`Alea`), which GarageBand requires.
- `patchVersion`: bump when a change needs migration (§5).

## 3. Parameters (phase 2)

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
| `range(min, max)` | Real-world units. |
| `log()` / `exp(k)` / *(default linear)* | Knob travel curve. |
| `def(v)` | Default, in real units. |
| `unit(s)` | Shown in UI and host. |
| `step(s)` / `integer()` | Quantise. |
| `choices({...})` | Enum parameter; value is the index. |
| `toggle()` | Boolean. |
| `modulatable()` | Appears as a mod matrix destination. |
| `smoothing(ms)` | Default 10 ms for floats, 0 for choices/toggles. |
| `group(s)` | Groups params in the host's list. |
| `hidden()` | Saved in patches, not shown to the host. |

**Kit-provided parameters** are added automatically according to `features`:
`master` (dB), `voiceMode`, `glide`, `bendRange`, `unison`, `unisonDetune`,
`unisonSpread`, and for each standard envelope/LFO its own controls (e.g.
`env1.attack`, `lfo1.rate`, `lfo1.sync`). Their IDs are reserved; anything
containing a `.` or starting with `sk.` is reserved.

## 4. Engine: voices and global processing (phase 2)

```cpp
struct MyVoice : Voice {
  dsp::Osc osc;
  dsp::Svf filter;

  void prepare(const PrepareInfo& info) override;   // sample rate, max block
  void start(const NoteOn& n) override;              // note, velocity, legato?
  void release() override;                           // key up (after sustain)
  void render(VoiceContext& ctx, Buffer& out) override;  // ADD into out
  bool active() const override;                      // false = voice is free
};

struct MySynth : Synth {
  void defineParams(ParamBuilder&) override;
  std::unique_ptr<Voice> makeVoice() override { return std::make_unique<MyVoice>(); }

  // optional
  void defineModSources(ModSourceBuilder&) override;     // §6
  void prepare(const PrepareInfo&) override;
  void processGlobal(GlobalContext&, Buffer& io) override; // FX after voices
};
```

Inside `render`:

```cpp
float fc  = ctx.get(synth.cutoff);   // smoothed + this voice's modulation
float res = ctx.get(synth.reso);
float pitchHz = ctx.pitchHz();       // includes bend, glide, unison detune
float amp = ctx.ampEnv();            // if the standard env1 drives amplitude
const Transport& t = ctx.transport(); // bpm, playing, beat position
```

- **Control rate.** Parameter and modulation values update every 32 samples.
  `ctx.get()` is constant within a sub-block; use `ctx.ramp(param)` for a
  per-sample linear ramp when it matters (e.g. amplitude).
- The kit splits blocks at MIDI events, so `start`/`release` are sample-accurate.
- Voice allocation, stealing (oldest released → quietest → oldest), mono/legato
  note priority (last note), glide and sustain pedal are handled by the kit.
- **Escape hatch:** override `Synth::onMidi(const MidiEvent&)` and return `true`
  to consume an event before the kit sees it (e.g. a synth that triggers its own
  internal note sequences). Use `spawnVoice(NoteOn)` to start a voice manually.

### Real-time rules (enforced by tests in debug builds)

In `start`, `release`, `render`, `processGlobal`, `onMidi`: no memory
allocation, no locks, no file/console I/O, no exceptions. Allocate in
`prepare`. `dsp::Rng` is the only randomness to use (seedable, allocation-free).

## 5. Patches (phase 2)

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
  "mod": [
    { "src": "lfo1", "dst": "cutoff", "amt": 0.25 },
    { "src": "velocity", "dst": "reso", "amt": -0.1, "via": "modwheel" }
  ]
}
```

- On load: missing params → default; unknown params → ignored; values clamped.
- When a change needs more than that (e.g. splitting one param into two), bump
  `patchVersion` in `synth.json` and implement:
  ```cpp
  void migratePatch(int fromVersion, PatchData& p) override;
  ```
- Factory presets live in `presets/`. User presets are saved by the host shell
  (browser storage, or the plugin's user folder) and can be exported as files.
- The same JSON is what the plugin stores inside your DAW project.
- MIDI-learn mappings are **not** part of a patch; they're per-installation.

## 6. Modulation (phase 4)

**Sources** provided by the kit: `env1`, `env2`, `lfo1`, `lfo2`, `velocity`,
`key` (key tracking, 0 at C4), `modwheel`, `aftertouch`, `bend`, `random`
(new value per note), `const` (fixed 1.0, for offsets via `via`).

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

## 7. Tempo (phase 4)

`ctx.transport()` → `{ bpm, playing, beat, barStart, timeSigNum, timeSigDen }`.
In the plugin this comes from the host. In the browser it comes from incoming
MIDI clock if present, otherwise the shell's internal clock (BPM control in the
toolbar).

Synced values use `sk::Division` (`1/1` … `1/32`, with `T` triplet and `.`
dotted). Standard LFOs have this built in (`lfo1.sync`). For your own:
`ctx.divisionSeconds(Division::Eighth)`.

## 8. DSP building blocks (phase 2)

All in `sk::dsp`, header-only, allocation-free after `prepare`.

| Block | Notes |
|---|---|
| `Osc` | sine, saw, square/pulse (PWM), triangle; PolyBLEP anti-aliasing; hard sync |
| `Noise` | white, pink |
| `Svf` | state-variable filter (LP/HP/BP/notch), stable under fast modulation |
| `Ladder` | 4-pole low-pass with drive |
| `Adsr` | linear-in-dB curves, retrigger/legato modes |
| `Lfo` | sine/tri/saw/square/S&H; free or synced; phase reset on note |
| `Smoother` | one-pole parameter smoothing |
| `Delay` | fractional delay line (for chorus/echo in `processGlobal`) |
| `Rng` | seedable xorshift; `uniform()`, `normal()`, `chance(p)`, `pick(weights)` |
| `softclip`, `Limiter` | the kit always applies a safety limiter before output |
| `mtof`, `dbToGain`, … | conversions |

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
identically in the browser and the plugin.

## 10. Testing a synth (phase 2)

Scenarios in `tests/*.json` render offline and are checked in CI:

```json
{
  "patch": "presets/init.json",
  "events": [
    { "t": 0.0, "on": 60, "vel": 100 },
    { "t": 0.5, "on": 64, "vel": 60 },
    { "t": 1.5, "off": 60 }, { "t": 1.5, "off": 64 }
  ],
  "length": 3.0,
  "expect": { "peakBelow": -0.3, "notSilentAfter": 0.01, "silentAfter": 2.8 }
}
```

The kit also runs generic checks on every synth: no NaN/inf, no denormal
slowdowns, every preset loads and round-trips, random patches don't blow up,
all-notes-off really is silent, and 44.1/48/96 kHz all render.

Command line: `sk-render tests/chord.json --out chord.wav` (writes the WAV and
prints the checks).

## 11. Targets

| Target | Used in | Phase |
|---|---|---|
| Web (WASM + AudioWorklet, GitHub Pages) | development, quick play | 3 |
| VST3 (Windows, macOS) | Ableton Live, Reaper | 5 |
| AU (macOS) | GarageBand, Logic, Reaper | 5 |
| CLAP | Reaper, Bitwig | optional, later |
