# synthkit API

This page is everything you need to build a synth on synthkit. A synth should
not need to read synthkit's source; if it does, this page is missing something.
[examples/basic](examples/basic) uses most of it, and
[examples/reed](examples/reed) is a synth with its own page, messages and
Web Audio blocks.

Include `<synthkit/synth.h>`; everything is in namespace `sk` (DSP blocks in
`sk::dsp`, and Web Audio's nodes in `sk::wa`, §8a).

---

## 1. What a synth repo contains

Start one with the scaffold, in an empty folder or a freshly cloned empty repo:

```
git clone https://github.com/10d6/synthkit /tmp/synthkit
python3 /tmp/synthkit/tools/new-synth.py my-synth --name "Glass Rain" [--plugin-code Glra] [--id glass-rain]
```

It copies `template/` (a small working synth: one oscillator, a filter that
CC 74 moves, the kit's envelope, LFO, mod matrix and voice modes, with its
tempo saved in patches), fills in the identity, checks
the permanent codes (§2), and adds synthkit as a submodule pinned to the
commit it came from. The result builds, passes every check, and has CI ready
(below). Run it with `--help` for the options.

```
my-synth/
  synthkit/            git submodule, pinned to a commit
  synth.json           identity + feature flags
  src/Synth.cpp        params, voice, optional hooks
  ui/layout.json       which controls go where (§9)
  ui/custom.js         optional: custom widgets (§9)
  ui/style.css         optional: the synth's own styles, after the kit's (§9)
  ui/page.html,        optional: the synth's own page instead of the kit's
  ui/page.js, ui/page/ (§9a)
  presets/*.json       factory patches (embedded into the build)
  tests/*.json         render scenarios run in CI
  CMakeLists.txt
  .github/workflows/ci.yml
  README.md, CLAUDE.md
```

```cmake
cmake_minimum_required(VERSION 3.22)
project(my-synth LANGUAGES C CXX)   # C (and OBJC/OBJCXX on macOS) for the plugin build
if(APPLE)
  enable_language(OBJC OBJCXX)
endif()
add_subdirectory(synthkit)
include(CTest)
synthkit_add_synth(mysynth SOURCES src/Synth.cpp)
```

`synthkit_add_synth` builds `mysynth_synth` (a library with the synth, its
`synth.json` and presets embedded), `mysynth_render` (the render/check tool,
§10) and a CTest test that runs every check. With the browser toolchain the
same call builds `<name>.html` instead (§11), and with `-DSYNTHKIT_PLUGIN=ON` it
also builds the plugins (§12).

Everything else (MIDI, voices, patches, mod matrix, UI binding, automation,
messages between page and engine, web build, plugin builds) comes from
synthkit. A synth that keeps the kit's page needs only `layout.json`; one with
a look of its own adds `ui/page.js` (§9a).

**CI** (the template's `ci.yml`) runs on every PR: native checks (§10), the
browser page in Chromium compared with the native render (the scenario in the
workflow's `SCENARIO`), a GitHub Pages preview linked on the PR, and plugin
builds for Windows, macOS and Linux with a zip per OS (§12). A `v*` tag
publishes a release. The steps are scripts in `synthkit/tools/ci/`, so they
move with the submodule.

**Updating synthkit** in a synth repo: `git -C synthkit fetch && git -C
synthkit checkout <commit>`, commit the new submodule pointer, and let CI
check the synth against it.

## 2. `synth.json`: identity

```json
{
  "id": "glass-rain",
  "name": "Glass Rain",
  "vendor": "10d6",
  "version": "0.1.0",
  "pluginCode": "Glra",
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
  followed by three lowercase (`Glra`), which GarageBand requires.
- `patchVersion`: bump when a change needs migration (§5).
- `name`, `vendor` and `version` are what DAWs show. `version` should go up
  with each release you install.
- `bundleId` (optional, default `com.<vendor>.<id>`): the macOS bundle
  identifier. Also **permanent** once released.

| Feature | Default | Meaning |
|---|---|---|
| `voices` | 8 | voice slots; **each unison layer uses one** (8 voices × unison 4 = 2 notes) |
| `voiceModes` | `["poly"]` | any of `poly`, `mono`, `legato`; more than one adds a `voiceMode` param |
| `unison` | false | adds `unison` (1–8), `unisonDetune`, `unisonSpread` |
| `standardEnvelopes` | 1 | ADSRs the kit runs per voice (`env1`, `env2`, …) |
| `ampEnv` | true | `env1` shapes every voice's output (see §4) |
| `eventQueue` | 256 | capacity for scheduled events (§4a) |
| `tempoInPatch` | false | the browser's tempo and time signature are saved in patches and restored with them (§7) |
| `standardLfos` | 0 | standard LFOs (§6) |
| `modSlots` | 0 | matrix routes; also adds `sk.pitch`, `sk.level` (§6) |
| `shapes` | 0 | drawn, tempo-locked curves (§6a) |
| `arp` | false | the kit's arpeggiator and step sequencer, with their note and phrase envelopes (§4b) |

## 3. Parameters

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
| `cc(n)` / `cc(n, lo, hi)` | MIDI controller `n` (0–119) moves this parameter: 0…127 across the whole range, or across `lo`…`hi` (real units, spaced by knob travel). Call it again for more controllers. |

**MIDI controllers** declared with `cc()` work the same in the browser and in
a DAW: the engine moves the parameter at the CC's own sample, not at the
start of the host's audio block, so a mapped controller sounds the same at
any block size and can drive something fast like tremolo depth directly. The
page's control and the host's (its automation lane, a learned DAW controller)
follow. The synth still sees the CC in `processEvents`; there, `ctx.get` still
reads the block-start value, because the move hasn't happened yet. A mapping
that depends on something else (CC 7 moves one setting or another) goes in
`processEvents` with `ctx.setParam(p, value)` (§4a), which moves the
parameter from the start of the block, with the page and host following. In
the browser, a control MIDI-learned on the page (§9) takes its CC instead.

```cpp
swell = b.add("swell").range(0, 100).unit("%").cc(11).cc(4);   // expression or foot pedal
level = b.add("level").range(0, 150).def(100).unit("%").cc(7, 0, 100);
```

Mistakes (duplicate IDs, reserved IDs, `log()` on a range through zero) are
reported when the synth is created (`sk::fail`), so they show up in the first
test run. `b.count()` is how many parameters have been added so far (the
next one's index) and `b.idAt(i)` the ID of the `i`th, for code that builds
parameters in loops or checks what's already there.

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

| ID | When | Range | Default |
|---|---|---|---|
| `master` | always | −60…+6 dB | 0 |
| `voiceMode` | more than one voice mode | choices: the `voiceModes` in the order listed (`["poly", "mono", "legato"]` → 0 Poly, 1 Mono, 2 Legato) | 0 |
| `glide` | a mono or legato mode exists | 0…5 s | 0 |
| `bendRange` | always | 0…24 st, integer | 2 |
| `unison` | `unison: true` | 1…8, integer | 1 |
| `unisonDetune` | `unison: true` | 0…100 ct | 12 |
| `unisonSpread` | `unison: true` | 0…1 | 0.5 |
| `sk.a4` | always | 400…480 Hz | 440 |
| `envN.attack` | per standard envelope | 0.0005…10 s | 0.005 (amp env), 0.01 |
| `envN.decay` | | 0.001…20 s | 0.3 (amp env), 0.5 |
| `envN.sustain` | | 0…1 | 0.8 (amp env), 0.3 |
| `envN.release` | | 0.002…20 s | 0.25 (amp env), 0.4 |
| `envN.velocity` | | 0…1: how much velocity scales the envelope | 0.5 (amp env), 0 |

"Amp env" is `env1` when `ampEnv` is on; other envelopes get the second
default.

The modulation parameters (`sk.pitch`, `sk.level`, `sk.ageSpan`, `lfoN.*`,
`shapeN.*`) are listed in §6 and §6a. Choice parameters are stored as 0-based
indices (in patches, `ctx.choice`, scenarios' `params`), so the choice lists
in this page are given in index order.

Those IDs, and any ID starting with `sk.`, `env<n>.`, `lfo<n>.` or
`shape<n>.`, are reserved, and so is `arp.` when `features.arp` is on (§4b). Otherwise `.` is fine for grouping (`osc2.level`).

**Using kit parameters.** A synth can give a kit parameter its own default,
and read any kit parameter like its own:

```cpp
void defineParams(ParamBuilder& b) override {
  // …
  b.kitDefault("env1.attack", 0.08);   // this synth's Init starts here
  b.kitDefault("env1.velocity", 0);
}
Param envDecay;
void prepare(const PrepareInfo& info) override {
  envDecay = info.param("env1.decay");  // any ID, kit or own; then ctx.get(envDecay)
}
```

`kitDefault` matters because patches only store values that differ from the
defaults: a synth that wants a different starting point must change the
default, not just its Init preset. Unknown IDs are reported (`sk::fail`).

**Parameter or custom setting?** If the host should automate it, or the mod
matrix should reach it, make it a parameter. If it's bulk data (a 128-key
table, a step sequence, a sample map) or structure rather than a value, use
custom state (§5a).

## 4. Engine: voices and global processing

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
  void defineMessages(MessageBuilder&) override;             // §9b
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
- `s.arp`: the kit's arpeggiator played this note (§4b).

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
| `arpNote()`, `arpEnv()` | the arpeggiator played this note; its note envelope (block start, 0 for other notes) (§4b) |
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
  voices. CC123 releases all notes. The kit's own *Stop all sound* and all
  notes off reach `processEvents` as CC120 and CC123 too, so a synth keeping
  its own note state (a coupler, a held phrase) can let go. Pitch bend is smoothed over ~4 ms. Every
  CC's last value is readable with `cc(n)`.
- **Output.** `master` gain, then a safety limiter (−0.3 dBFS ceiling). NaN or
  infinite samples are replaced with silence. Denormals are flushed.

**Tuning.** Notes default to 12-TET, with A4 set by `sk.a4`. To change that,
override `tune`:

```cpp
double tune(int note, const NoteContext& n) override;  // returns a fractional MIDI note
```

It's called once per note start, with `n.note`, `n.velocity`, `n.channel`,
`n.rng` (seeded per note) and `n.transport`. `n.get(p)`, `n.choice(p)` and
`n.on(p)` read parameters as the note starts (smoothed, plus global
modulation, §6: the values `EventContext::get` reads; per-voice modulation
hasn't started yet). So `tune` can use parameters, custom state or
randomness: per-key detune tables, drifting "worn instrument" tuning,
alternate temperaments. Everything downstream (`pitchHz`, key tracking, glide)
uses the result.

**Global processing.** `processGlobal(GlobalContext& ctx, Buffer& io)` runs once
per control block after the voices are mixed, and edits `io` in place (reverb,
delay, chorus…). `GlobalContext` has `get/choice/on/ramp`, `modwheel()`,
`cc(n)`, `activeVoices()`, `lfo(n)`, `shape(n)`, `setSource(src, v)` (§6),
`post(message, {values})` (§9b), `transport()`, `sampleRate()`.

**Escape hatches.** The kit's defaults are meant to be overridden when a synth
needs something unusual:

- `processEvents` (§4a) → reshape, swallow or generate MIDI before voices.
- `allocateVoice(n, pool)` → return the slot index for a new note (or −1 to
  drop it). `VoicePool` has `size()`, `limit()`, `activeCount()`,
  `state(i)`, `note(i)`, `age(i)`, `level(i)`, `findFree()`, `fadeOut(i)` and
  `defaultAllocate(n)` (the policy above). Example: a fixed voice per key,
  like a piano emulation.
- `processGlobal` → anything that happens after the voices are mixed (a
  reservoir that playing drains, a whole-instrument effect chain).
- Messages (§9b) → input from the page that isn't a parameter (a held treadle,
  a "new reeds" button), and news back to it.
- A synth's own page (§9a) → when the kit's panels aren't the instrument.

If an escape hatch is used in a second synth for the same reason, that's the
signal to turn it into a kit feature.

## 4a. Event processing in musical time

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
| `ctx.rng(e, perKey)` | a `dsp::Rng` (by value) for this event; `perKey = true` gives the same stream for that key every time |
| `ctx.get(p)`, `ctx.choice(p)`, `ctx.on(p)` | parameter values (global modulation, §6) |
| `ctx.transport()`, `ctx.sampleRate()`, `ctx.pending()` | |
| `ctx.trigger(n)` | restart shape n now (§6a) |
| `ctx.setSource(src, v)` | set a custom mod source's global value (§6) |
| `ctx.setParam(p, value)` | move a parameter: in effect from the start of this block (unlike a `cc()` mapping, which moves at the CC's own sample, §3); the page and the host follow |
| `ctx.messages()`, `ctx.post(m, {values})` | messages from the page since the last block, and sending one back (§9b) |

Events are `MidiEvent`s (`type`, `note`, `vel`, `cc`, `value`, `channel`,
`sample`, `beat`, `tag`, `arp` and `arpLane` (§4b), plus `isNoteOn()`, `isNoteOff()`, `isCC(n)`). Build
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
  starting playback somewhere new), the kit calls
  `void onTransportJump(EventContext& ctx) override` before the block's
  `processEvents`. By default it drops pending events and fires pending
  note-offs; an override that keeps its own schedule (a phrase in progress)
  should move it to `ctx.now()` and then call `Synth::onTransportJump(ctx)`.
- MIDI output to the host is not planned (Live 11 handles MIDI out from
  instruments poorly).

### Real-time rules (checked by the render tool)

In `start`, `release`, `render`, `processGlobal`, `processEvents`, `tune` and
`allocateVoice`: no memory allocation, no locks, no file or console I/O, no
exceptions. (Synth code never uses exceptions at all, because the browser
build doesn't have them: §11.) Allocate in `prepare`. Use `dsp::Rng` for randomness (seedable,
allocation-free). The render tool counts every allocation made while the
engine is processing audio, and fails on any.

The setup calls of the Web Audio blocks allocate, so they belong in
`prepare` too: `wa::Convolver::setImpulse`, `wa::PeriodicWave::build`,
`wa::WaveShaper::setCurve`, `wa::Delay::prepare` and `wa::Param::reserve`
(§8a). Messages (`ctx.messages()`, `ctx.post`) never allocate.

## 4b. The arpeggiator and step sequencer

`"arp": true` in `synth.json`'s features adds the kit's arpeggiator and step
sequencer, two ways of playing notes from the keys you hold. `arp.on` picks
one: **Off** (the default, so a synth can offer them without changing any of
its sounds), **Arp** or **Sequencer**. They share a step clock (rate, swing,
gate), drawn patterns, the generator, Evolve and the two envelopes; what
differs is what they do with the keys:

- **Arp** plays the held keys one after another (the keys themselves don't
  sound). Its pattern rows are chord tones.
- **Sequencer** lets each key sound as usual and gives it its own copy of a
  pattern of notes at intervals from that key (§ Sequencer, below).

```
MIDI in → synth's processEvents (§4a) → arpeggiator / sequencer → voices
```

It runs **after** the synth's `processEvents`, so a synth can reshape the keys
first (couplers, splits, its own generated notes) and the arpeggiator or
sequencer plays the result. The arpeggiator keeps the note-ons and note-offs
it receives and plays its own notes instead; the sequencer passes them on (the
keys sound) and adds its own. Everything else (controllers, bend, the synth's
messages) passes through. Their notes go through the normal voice stage:
tuning, voice allocation, unison and modulation all apply, and the
arpeggiator's notes follow the voice mode too: in Mono or Legato, a gate over
100% makes overlapping notes, so Legato glides between steps. (The
sequencer's notes get voices of their own: below.)

**Parameters** (choices in index order):

| Param | Values | Default |
|---|---|---|
| `arp.on` | 0 Off, 1 Arp, 2 Sequencer | Off |
| `arp.mode` | 0 Up, 1 Down, 2 Up/Down, 3 Down/Up, 4 As Played, 5 Random (never the same note twice in a row), 6 Chord (every held note, each step), 7 **Pattern** (a drawn pattern, below) | Up |
| `arp.pattern` | 1–8: which drawn pattern plays, in the arpeggiator's Pattern mode or the sequencer (each has its own bank), so pattern changes can be automated or modulated | 1 |
| `arp.evolve` | 0–100 %: the arpeggiator's Pattern mode and the sequencer vary the pattern as it repeats (below) | 0 |
| `arp.octaves` | 1–4: the held notes repeat this many octaves up (Chord moves the whole chord up an octave each step; Pattern ignores it, since its rows reach any octave) | 1 |
| `arp.rate` | 0 1/1, 1 1/2, 2 1/4., 3 1/4, 4 1/4T, 5 1/8., 6 1/8, 7 1/8T, 8 1/16., 9 1/16, 10 1/16T, 11 1/32 | 1/16 |
| `arp.gate` | 5–200 %: each note's length, as a share of a step | 50 % |
| `arp.swing` | 0–100 %: delays every other step; 100 % is a third of a step late (a triplet feel) | 0 |
| `arp.latch` | toggle: the chord keeps playing after the keys are up; the next key pressed with none held starts a new chord | off |
| `arp.sync` | 0 **Grid** (steps fall on the song's grid: a key waits for the next step, or plays at once if it's no more than 40 ms late for one), 1 **Key** (steps count from the first key of a phrase) | Grid |
| `arp.velMode`, `arp.velFixed` | 0 Played (each note's own velocity), 1 Fixed (`arp.velFixed`, 1–127) | Played, 100 |
| `arp.envMode` | the note envelope: 0 **Off**, 1 **Multiply**, 2 **Replace**, 3 **Crossfade** (below) | Multiply |
| `arp.xfade` | 1–100 %: Crossfade's fade time, as a share of a step | 30 % |
| `arp.attack`, `arp.decay`, `arp.sustain`, `arp.release` | the note envelope (same ranges as `envN.*`) | 2 ms, 0.3 s, 1, 50 ms |
| `arp.phraseAttack`, `…Decay`, `…Sustain`, `…Release` | the phrase envelope | 2 ms, 0.5 s, 1, 50 ms |
| `arp.scale` | Sequencer: 0 Chromatic (rows are semitones), 1 Major, 2 Minor, 3 Dorian, 4 Phrygian, 5 Lydian, 6 Mixolydian, 7 Locrian, 8 Harmonic Minor, 9 Melodic Minor, 10 Major Pentatonic, 11 Minor Pentatonic, 12 Blues, 13 Whole Tone | Chromatic |
| `arp.scaleKey` | Sequencer: the scale's key, 0 C … 11 B | C |
| `arp.seqSync` | Sequencer: 0 **Grid**, 1 **Key** (below) | Key |
| `arp.quantize`, `arp.quantizeTo` | Sequencer, with Key sync: lock each key's sequence to the nearest increment of `arp.quantizeTo` (the `arp.rate` values, 0 1/1 … 11 1/32) | off, 1/4 |
| `arp.keyLevel`, `arp.seqLevel` | Sequencer: −60 (silent) … +6 dB: the keys you play, and the notes the sequencer adds. The master level applies to both | 0 dB, 0 dB |

`arp.mode`, `arp.octaves` and `arp.sync` are the arpeggiator's; the
`arp.scale…`, `arp.seqSync`, `arp.quantize…` and level parameters are the
sequencer's. The kit's panel shows only the ones for the type that's on (and
Quantize only with Key sync). In a DAW's parameter list they're grouped as
**Arp / Sequencer**, **Arp / Seq Note Envelope** and **Arp / Seq Phrase
Envelope**. Gate, swing, evolve, pattern, crossfade and the two levels are
also mod destinations (**Modulation**, below).

**Drawn patterns** (`arp.mode` Pattern). Eight patterns, each up to 64
steps long, drawn in the piano roll (`{ "kit": "arpPattern" }`). A
pattern's **rows are chord tones**, not pitches, so one pattern plays over
any chord: row 1 is the lowest held note, row 2 the next, and rows past the
held notes carry on an octave up (holding C E G, rows 1–6 are C E G C' E'
G'); rows below 1 go down the same way. Each note has a step, a row, a
length in steps (it lasts `length − 1 + gate` steps), a velocity (scaled by
the key's velocity, or by `arp.velFixed` with Fixed) and a chance of playing
(0–100 %, from the phrase's own random stream, so renders repeat). A step can
hold several notes (a chord), or none (a rest). The pattern starts with the
phrase and loops; `arp.rate`, `arp.swing` and `arp.sync` apply as in the
other modes.

The patterns are saved in the patch as custom state (§5a) under `"sk.arp"`,
which the kit reserves when `features.arp` is on:

```json
"custom": { "sk.arp": { "patterns": [
  { "steps": 8, "notes": [[0, 0, 1, 112], [1, 2, 1, 88], [2, 1, 2, 88, 50]] }, …
] } }
```

Each note is `[step, row, length, velocity, chance]` with rows 0-based (row 1
in the editor is `0`; −24…47) and `chance` optional (100). The sequencer's
patterns are the same format under `"sk.seq"`, with rows as intervals (row 0
the key; negative rows below it); both names are the kit's when
`features.arp` is on. Patterns a patch
leaves out are empty; a patch without `"sk.arp"` gets the default bank, whose
pattern 1 is a broken chord. A synth can read or change it like its own
custom state: `ctx.custom("sk.arp")` in a custom widget or page,
`Engine::customState("sk.arp")` from code.

The piano roll: click to add a note and drag to lengthen it; drag a note to
move it, its right end to resize it; double-click (or double-tap) removes it;
right-click for its chance. Keys: `,` and `.` select notes, arrows move the
selected one, Shift+←/→ change its length, Delete removes it. The lane
underneath sets velocity or chance per step. **Edit…** clears, copies and
pastes patterns, shifts them in time or by a chord tone, reverses, flips and
doubles them. A playhead follows the pattern while a phrase is playing.

**Generating patterns.** **Generate…** in the piano roll draws a pattern that
is random but shaped like a played line, from a seed (so an idea can be
found again):

- **Rhythm** leans on the strong steps: downbeats almost always play, and
  **Density** decides how far it fills in between (sixteenths last).
- **Motifs and form:** the pattern is built from short motifs (4 steps, or 8
  in patterns of 32 or more) arranged in a form: AABA or AAAB with high
  **Repetition**, ABAB or ABAC in the middle, ABCB or ABCD with low. Repeats
  come back slightly changed (shifted a chord tone, a new last note, an
  offbeat added or dropped) more often with less repetition.
- **Melody:** each motif follows a contour (rising, falling, arch or valley)
  over chord tones within **Range**, mostly by step; **Leaps** makes jumps,
  and a leap is followed by a step back. The first motif starts on the
  lowest chord tone, on the downbeat; later ones start at a contrasting
  height; the last note leans back towards the start so the loop joins up.
- **Accents** follow the beat (with a little humanising), **Ties** hold notes
  into the rests after them, and **Chords** adds a second chord tone on
  strong steps.

**New idea** draws from a new seed; after that, moving a slider (or changing
the length) redraws the same idea, until the pattern is edited by hand.
**Undo** brings back the pattern from before. The result is an ordinary
pattern: edit it, save it with the patch. For the sequencer it writes
intervals: with Chromatic, from a ladder that sits well over any key (0, 3,
5, 7, 10, 12, 15… semitones, so a step is never a clash), with a scale, in
scale steps; its lines start mid-range, above the key that's already
sounding.

A synth's own page or custom widget can use the same generator:
`sk.arpGenerate(settings)` (`ctx.arpGenerate` in a widget) takes
`{ steps, density, range, leaps, repetition, ties, chords, seed, kind }`
(`kind` 0 chord tones, 1 semitones, 2 scale steps; the others default to the
Generate… panel's starting values) and returns one pattern
(`{ steps, notes }`); put it into `"sk.arp"` or `"sk.seq"` with
`setCustom`. Engine-side code (tests, tools) calls
`sk::arpGeneratePattern(const Json&)` in `engine.h`, which is the same
function.

**Evolve** (`arp.evolve`) changes the pattern as it plays: each time it comes
round, there's a chance (rising with the amount) that a note or two moves a
chord tone, a step earlier or later, drops out (or comes back), or gets
louder or softer. Changes accumulate, but at most about half the notes (at
100 %) differ from the drawn pattern at once, so it stays recognisable. The
drawn pattern itself doesn't change, and each phrase starts from it again.
It's deterministic per phrase, like everything else here.

**Sequencer** (`arp.on` Sequencer). Each key you press sounds as usual (it's
passed on to the voices like any note) and also starts its own **lane**: a
copy of the selected pattern whose rows are intervals from that key. Hold C
with a pattern of +12, +7, +10 and you hear C, plus C', G and B♭ on their
steps; hold F as well and its own lane plays F', C', E♭. Up to 16 keys have
lanes at once (a 17th reuses the oldest released lane, else the oldest).

- **Rows:** with `arp.scale` Chromatic, a row is a number of semitones from
  the key (row 0 is the key itself, ±12 its octaves). With a scale, a row is
  a number of steps along that scale (in `arp.scaleKey`), so every key's
  lane stays in that one key: in C major, +2 from E is G, from F it's A.
  A key that isn't in the scale counts from the scale note below it; the key
  itself is never changed, and row 0 is always the key. Changing the scale
  reinterprets the rows (a +4 is a major third chromatically, a fifth in a
  major scale).
- **Timing:** with `arp.seqSync` **Key** (the default), each lane starts at
  step 1 when its key goes down, so keys pressed at different times run
  their own phase. With **Grid**, a lane joins the pattern where the song's
  grid is (a key on beat 2 starts on the pattern's step 5 at 1/16), so all
  lanes line up; a key no more than 40 ms late for a step plays it at once.
- **Quantize** (`arp.quantize`, with Key sync): each lane locks to the
  nearest increment of `arp.quantizeTo` (a 1/4 note is one beat). A key
  pressed before the increment waits for it: step 1 falls on it. A key
  pressed after it plays step 1 at once (so it's never lost), and the steps
  after it fall on the timeline counted from the increment; one pressed more
  than a step late skips the slots already gone rather than shifting the
  pattern. The key itself always sounds when it's pressed.
- **Each lane has its own phrase envelope:** it starts with its key and
  releases when that key is let go (or pedal-released); the lane keeps
  playing through the release and stops at silence. Pressing the same key
  again picks its lane back up (from step 1 with Key sync). Latch keeps
  lanes going after their keys are up; the next key pressed with none held
  lets them all go.
- **Voice modes:** the keys follow `voiceMode` as usual (in Mono or Legato
  they share one voice and glide); the lanes' notes always get voices of
  their own, so they play over the key instead of taking its voice. (The
  arpeggiator's notes do use the single voice: they're the melody.)
- **Levels:** `arp.keyLevel` scales the keys and `arp.seqLevel` the lanes'
  notes, only while the sequencer is on.
- The pattern bank is the sequencer's own (`"sk.seq"`, below), separate from
  the arpeggiator's; `arp.pattern` picks from whichever is in use. Its
  default pattern 1 is +12, +7, +10, +7, +5 over 8 steps.
- `arp.velMode`, `arp.gate`, `arp.swing`, `arp.evolve` and the pattern's
  lengths, velocities and chances work as for the arpeggiator; `arp.mode`,
  `arp.octaves` and `arp.sync` don't apply.

The sequencer's notes are flagged `MidiEvent::arp` with `arpLane` set to their
lane (0–15); a voice sees them as `ctx.arpNote()`. The mod sources
`arp.phrase` and `arp.step` follow the most recently started lane.

**Two envelopes.** Both are applied by the kit, like the amp envelope (§4):

- The **note envelope** shapes each note the arpeggiator or sequencer plays
  (not the keys), starting with the note and releasing when the gate ends. **Multiply** puts it on top of
  the voice's own sound (the kit's amp envelope included), so it works with
  any synth. **Replace** uses it *instead of* the kit's amp envelope (`env1`
  with `ampEnv`), so a slow pad's attack doesn't swallow short arpeggiated
  notes. Replace can only replace what the kit applies: a voice that shapes
  its own attack (samples, a custom attack stage) still does, unless it checks
  `ctx.arpNote()` (or `StartInfo::arp`) and skips it. With Multiply or
  Replace, a note ends when its note envelope does.
- **Crossfade** replaces both shapes with fades: each note fades in over
  `arp.xfade` of a step (equal-power, so two fading notes keep the level
  steady) and lasts until the next step, where it fades out as the next one
  fades in. Rests fade out to silence; a tied note fades out when it ends;
  in the sequencer, the same pitch on consecutive steps just carries on as
  one note rather than fading into itself. `arp.gate` doesn't apply. Like
  Replace, it takes the place of the kit's amp envelope. Each new note is
  still a new voice: a sound with its own attack (a sample, a filter
  envelope) keeps it, so crossfades soften the change rather than morph one
  pitch into the next (for that, use Legato with glide). A crossfade uses two
  voices at once per lane.
- The **phrase envelope** is the arpeggiator's overall volume (in the
  sequencer, each lane's: above). It starts with
  the first key of a phrase (a key pressed when none are held) and releases
  when the last key is let go (or when Latch is turned off with no keys
  held). The arpeggio **keeps playing through the release**, on the chord that
  was held (keys let go of within 60 ms of the last one count), so it fades
  out instead of stopping; it stops when the envelope reaches silence. It
  only affects the arpeggiator's or sequencer's notes, never the keys.

Both are also mod sources (`arp.env`, `arp.phrase`, §6), along with
`arp.step`, so they can drive a filter or anything else the matrix reaches.

**Details:**

- **Sustain pedal.** Keys let go of while the pedal is down stay in the
  chord (or keep their sequencer lane going) until it comes up. The
  arpeggiator's and sequencer's own notes ignore the pedal (they'd pile up
  otherwise); in the sequencer the keys themselves are sustained as usual.
- **Turning it off** (or switching type): the arpeggiator hands keys still
  down back as ordinary notes until they're let go of; the sequencer's lanes
  stop stepping and their notes fade with the phrase envelope, while the keys
  (already sounding) carry on. Keys already sounding when it's turned on
  finish as ordinary notes.
- **Transport jumps** (a DAW looping): pending note-offs fire; with Grid sync
  the steps carry on from the next grid point, with Key sync from the jump.
- The kit's all notes off and panic stop it and forget latched chords and
  lanes, even if the synth's `processEvents` keeps CC 123 to itself.
- Its notes are flagged `MidiEvent::arp` (and `arpLane` for the sequencer's),
  and a note-off from it only ends a note it started.
- It doesn't use the event queue (`features.eventQueue`), and it runs
  sample-accurately: the result doesn't depend on the host's block size
  (unless modulation is routed to its step-time parameters, below).

**Modulation.** These are mod matrix destinations (§6):

| Param | How modulation applies |
|---|---|
| `arp.gate`, `arp.swing`, `arp.evolve`, `arp.pattern` | read when a step plays, with global modulation (per-voice sources such as velocity or a per-voice LFO count as 0, as in `processEvents`). `arp.pattern` rounds to a pattern, so a shape or LFO can switch between them (say, a different pattern each bar) |
| `arp.xfade` | read as each note starts, with global modulation |
| `arp.phraseAttack`, `…Decay`, `…Sustain`, `…Release` | the phrase envelope (each sequencer lane's too), with global modulation, updated once per host block. A phrase follows its settings as they move: a changed Sustain is reached at the Decay rate, and a stage in progress takes on its new rate |
| `arp.keyLevel`, `arp.seqLevel` | per voice, like `sk.level`: each key or sequenced note follows its own sources (velocity, key, a per-voice LFO, `arp.env`), ramped across each control block |

The step-time ones see the sources as of the last control block before the
audio block (a few milliseconds behind at most), so with modulation routed to
them the timing can differ slightly with the host's block size.

**Escape hatches.** A synth that needs a different arpeggiator leaves
`features.arp` off and writes its own in `processEvents` (§4a). One that wants
the kit's, but differently fed, reshapes the keys in `processEvents`; one that
wants arp notes to sound different reads `ctx.arpNote()` in its voice.

## 5. Patches

A patch is JSON, stored in **real units** so changing a range doesn't corrupt
old patches.

```json
{
  "synthkit": 1,
  "synth": "glass-rain",
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
  Neither are messages (§9b) or a page's own settings (`sk.store`, §9a): a
  sound that depends on something must keep it in a parameter or custom state.
- `"tempo"`, with `features.tempoInPatch`: `{ "bpm": 74, "timeSig": [4, 4] }`,
  the browser's tempo when the patch was saved (§7). A patch without one
  leaves the tempo as it was.
- `"mod"` holds the matrix routes (§6) and `"shapes"` the shape curves (§6a).
  A synth without those features keeps them unchanged through load and save.

## 5a. Custom state

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
- `sk::Json` is a small JSON value:
  - reading: `j["key"]`, `j[i]`, `number(fallback = 0)`, `string()` /
    `string(fallback)`, `boolean(fallback = false)`, `items()` (an array's
    elements), `members()` (an object's key/value pairs), `size()`,
    `contains(key)`, `isNull()`, `isNumber()`, `isString()`, `isBool()`,
    `isArray()`, `isObject()`, and `to(array)` / `to(vector)` for a list of
    numbers. Through a `const Json&` (as in `load`), missing keys and wrong
    types read as null or the fallback, never fail.
  - writing: assign numbers, bools, strings, `std::array` and `std::vector`;
    `Json::object()`, `Json::array()`, `push(value)`, `erase(key)`. On a
    non-const value, `j["key"]` and `j[i]` create what's missing and turn a
    null into an object or array; used on a value of another type they (and
    `push`) are an error (`sk::fail`).
  - text: `Json::tryParse(text, out, &error)` for input that may be malformed,
    and `dump(indent = 2)`.
- Custom state isn't automatable or modulatable. If one element needs that,
  promote it to a parameter (`ParamArray` covers per-pitch-class cases).
- The UI edits it through custom widgets (§9): `ctx.custom("keys")`,
  `ctx.setCustom("keys", value)`, `ctx.onCustom("keys", fn)`.
- `migratePatch` (above) can rewrite `"custom"` too.

## 6. Modulation

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
| `arp.env` | the arpeggiator's or sequencer's note envelope (or crossfade); 0 for notes it didn't play (§4b) | ✓ |
| `arp.phrase` | the phrase envelope (the sequencer's most recently started lane) (§4b) | |
| `arp.step` | where the arpeggio or sequence is in its cycle, 0→1, stepped (§4b) | |
| custom | the synth's own, below | if declared per voice |

**Matrix.** Up to `modSlots` routes, each `src → dst × amt`, with an optional
`via` (a second source that multiplies the amount). `amt` runs −1…1 of the
destination's full knob range, in normalised (knob) units, so an amount means
the same on a log cutoff as on a linear mix. Routes to the same destination
add, and the result is clamped to the parameter's range.

**Kit destinations,** added with `modSlots`:

| ID | Range | Default | |
|---|---|---|---|
| `sk.pitch` | −12…+12 st | 0 | pitch offset (vibrato, pitch envelopes). Every voice's `pitch()`/`pitchHz()` includes it. |
| `sk.level` | 0…1 | 1 | voice level, applied by the kit after the amp envelope (tremolo, gates, pedal pumps) |
| `lfoN.rate`, `lfoN.phase`, `lfoN.depth` | | | LFOs modulating LFOs (below) |
| `shapeN.rate`, `shapeN.offset`, `shapeN.depth` | | | §6a |
| `arp.gate`, `arp.swing`, `arp.evolve`, `arp.pattern`, `arp.xfade`, `arp.keyLevel`, `arp.seqLevel` | | | with `features.arp` (§4b) |

`sk.ageSpan` (1–32 beats, integer, default 4; not modulatable), also added
with `modSlots`, sets the span of `note.age`.

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

Custom sources show up in the matrix, in custom widgets (`ctx.onMeter`) and
on a synth's own page (`sk.onMeter`, §9a) like the built-in ones; a global
source set in `processGlobal` makes a good gauge, and its meter keeps moving
with nothing playing. A per-voice source that a voice hasn't set uses the
global value.

**Reading modulation directly.** In a voice, `ctx.lfo(n)`, `ctx.shape(n)` and
`ctx.source(src)` give this voice's values. In `processGlobal`, `ctx.lfo(n)`
and `ctx.shape(n)` give the global ones. This is for logic that doesn't fit the
matrix.

**Standard LFOs** (`standardLfos: 2` adds `lfo1`, `lfo2`):

| Param | Values (choices in index order) | Default | |
|---|---|---|---|
| `lfoN.shape` | 0 Sine, 1 Triangle, 2 Saw Up, 3 Saw Down, 4 Square, 5 S&H, 6 Drift (smooth random) | Sine | |
| `lfoN.rate` | 0.01–40 Hz, modulatable | 2 Hz | used when `sync` is off |
| `lfoN.sync` | toggle | off | lock to the beat, at `division` |
| `lfoN.division` | 0 8 bars, 1 4 bars, 2 2 bars, 3 1 bar, 4 1/2, 5 1/4., 6 1/4, 7 1/4T, 8 1/8., 9 1/8, 10 1/8T, 11 1/16, 12 1/16T, 13 1/32 | 6 (1/4) | one LFO cycle. A synced global LFO's phase comes from the song position, so it lines up with the bar whenever notes start. |
| `lfoN.mode` | 0 Global (one LFO shared by all voices), 1 Per Voice (restarts with each note) | Global | |
| `lfoN.phase` | 0…1, modulatable | 0 | phase offset / start phase |
| `lfoN.depth` | 0…1, modulatable | 1 | output scale |
| `lfoN.fade` | 0…10 s | 0 | per-voice fade-in after each note (classic delayed vibrato) |

Bar lengths follow the time signature; `.` is dotted and `T` triplet.

The patch stores routes as `"mod": [{ "src", "dst", "amt", "via"? }]`.
Unknown sources and non-modulatable destinations are dropped with a warning.

## 6a. Shapes: drawn, tempo-locked modulation

A shape is a curve you draw (points with adjustable curvature, or steps),
like an automation lane, that a note or the bar line plays back. It's a mod
source, so it can drive anything the matrix reaches. Example: an organ
"pedal pump" curve, one bar long, restarting with each new phrase and
pushing voice level and brightness (the example synth's *Pedal Pump* preset).

`features.shapes: 4` adds `shape1`…`shape4`. Raising the count later is safe
for existing patches and projects; lowering it isn't (patches using the
removed shapes lose them). Each shape has these parameters, so they're
automatable, and rate, offset and depth are modulatable too:

| Param | Values (choices in index order) | Default |
|---|---|---|
| `shapeN.length` | 0 16 bars, 1 8 bars, 2 4 bars, 3 2 bars, 4 1 bar, 5 1/2, 6 1/4., 7 1/4, 8 1/4T, 9 1/8, 10 1/8T, 11 1/16; used when `sync` is on | 4 (1 bar) |
| `shapeN.sync` | toggle; off: the length is `time` instead | on |
| `shapeN.time` | 0.01–30 s | 1 s |
| `shapeN.trigger` | 0 **Note** (per voice), 1 **First Note** (global, restarts when a note starts with no other key held), 2 **Bar**, 3 **Beat** (restarts every bar or beat), 4 **Free** (runs continuously, locked to song position), 5 **Manual** (only `ctx.trigger`) | Note |
| `shapeN.start` | 0 Immediately, 1 Next 1/16, 2 Next 1/8, 3 Next 1/4, 4 Next Bar (waits before starting; for Note, First Note and Manual) | Immediately |
| `shapeN.loop` | 0 **Once** (holds the end), 1 **Loop**, 2 **While Held** (loops while the key is down, then finishes the cycle), 3 **Ping-Pong**, 4 **Release** (plays to the curve's release point and holds there, then plays the tail on key up) | Once |
| `shapeN.rate` | playback speed, 0.25–4×, modulatable | 1 |
| `shapeN.offset` | phase offset 0…1, modulatable | 0 |
| `shapeN.depth` | output scale 0…1, modulatable | 1 |
| `shapeN.smooth` | slew 0…1, for softening steps | 0 |
| `shapeN.keyLow`, `shapeN.keyHigh` | 0–127: which keys may trigger it (Note and First Note) | 0, 127 |
| `shapeN.velLow`, `shapeN.velHigh` | 1–127: which velocities may trigger it | 1, 127 |
| `shapeN.curve` | 1–8: which stored curve plays (so curve changes can be automated) | 1 |

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

## 7. Tempo

`ctx.transport()` → `Transport { bpm, playing, beat, barStart, timeSigNum,
timeSigDen, source }`, plus `beatsPerBar()`, `secondsPerBeat()` and
`seconds(s)`. Every synth gets a tempo wherever it runs, so tempo-locked code
is written once:

| `source` (`sk::TempoSource`) | Where the tempo comes from |
|---|---|
| `Daw` | the plugin's host: its tempo, time signature and play position |
| `Browser` | the page's tempo controls (Play, BPM and time signature, in the host bar or wherever the page put them) |
| `MidiClock` | the page following incoming MIDI clock (choose *MIDI clock* next to the time signature): start, stop, continue and song position are followed, and tempo is measured from the clock |
| `Offline` | the render tool: the scenario's `transport`, else the patch's tempo |
| `Own` | nothing gives a tempo (a host without a play head): the kit's own clock, at the patch's tempo if it has one, else the last one it had |

`beat` keeps advancing when the transport is stopped (§4a). A synth that
behaves differently in a DAW (say, a pattern that should follow the song
there but keep its own pace in the browser) can check `source == Daw`.

**Tempo in patches.** With `"tempoInPatch": true` in `synth.json`'s
features, the browser's tempo and time signature are part of the sound: saved
in the patch (`"tempo"`, §5), restored when it loads, and changing them marks
the patch edited. In a DAW the song's tempo rules; the patch's tempo is kept
with it, and used only when the host gives none (`Own`).

Synced values use `sk::Division`: `Division::Whole`, `Half`, `Quarter`,
`Eighth`, `Sixteenth`, `ThirtySecond` and `Bar`, with `.triplet()` and
`.dotted()`. `d.length(transport)` gives beats. `Division::parse("1/8T", d)`
and `d.name()` convert to and from text: `"1/4"`, `"1/8T"` (triplet),
`"1/4."` (dotted), `"1 bar"` / `"2 bars"` (case and spaces ignored);
`parse` returns false for anything else. These are the same names the
`lfoN.division` and `shapeN.length` choices use.

## 8. DSP building blocks

All in `sk::dsp` (`#include <synthkit/synth.h>` brings them in), header-only,
allocation-free after `prepare`. Every block has `prepare(sampleRate)` (call it
from the voice's or synth's `prepare`) and processes one sample per call.

| Block | How to use it |
|---|---|
| `Osc` | `setWave(Osc::Wave::Sine / Saw / Square / Triangle)`, `setFreq(hz)` (per block is fine), `setPulseWidth(0.02…0.98)` for Square, `next()` per sample, `reset(phase)`, `phase()`. Band-limited (PolyBLEP/BLAMP): aliasing ≤ −46 dBc at 3 kHz. |
| `Noise` | `white()`, `pink()`; `seed(n)` it from `rng()` so voices differ |
| `Svf` | `setMode(Svf::Mode::LowPass / HighPass / BandPass / Notch)`, `set(hz, res 0…1)` (per sample is fine; res 1 ≈ Q 20), `process(x)`, `reset()`. Stable under fast modulation. |
| `Ladder` | 4-pole low-pass: `set(hz, res 0…1, drive = 1)`, `process(x)`, `reset()`; self-oscillates at res 1 |
| `OnePole` | `set(hz)`, then `lowpass(x)` or `highpass(x)`; `reset()`. Tone controls, DC blocking. |
| `Adsr` | `set(attack s, decay s, sustain 0…1, release s)`, `gate(true/false)`, `next()` per sample, `level()`, `idle()`, `stage()`, `reset()`. Linear attack from the current level (no clicks on retrigger); decay and release exponential (straight lines in dB). The kit's `envN` already cover the usual case. |
| `Lfo` | `setShape(Lfo::Shape::Sine / Triangle / Saw / Square / SampleHold)`, `setRate(hz)` + `advance(samples)`, or `syncTo(beat, periodBeats, offset)`; `value()` (or `value(rng)` for S&H), `phase()`, `reset(phase)` |
| `Smoother` | `prepare(sampleRate, ms)`, `setTarget(v)`, `next()` per sample or `advance(n)` per block, `reset(v)`, `value()` |
| `Delay` | `prepare(sampleRate, maxSeconds)`, `write(x)` once per sample, `read(samplesAgo)` or `readSeconds(s)` (fractional, cubic interpolation), `reset()` |
| `Rng` | `Rng(seed)` / `seed(n)`; `uniform()` [0, 1), `uniform(a, b)`, `bipolar()` [−1, 1), `integer(lo, hi)` inclusive, `chance(p)`, `normal()`, `pick({w0, w1, …})` → index by weight |
| `Limiter` | the kit already applies one before output |

Helpers: `mtof(note, a4 = 440)`, `ftom(hz)`, `dbToGain(db)`, `gainToDb(g)`,
`lerp(a, b, t)`, `clamp(x, lo, hi)`, `softclip(x)` (bounded to ±1),
`panGains(p −1…1, l, r)` (equal power), `hashSeed(a, b, c)` (mix numbers into
a seed for `Rng`), `flushDenormal(x)`, `kPi`, `kTwoPi`.

New blocks are added to the kit when a second synth needs them; until then they
live in the synth repo.

## 8a. Web Audio blocks

Synths often start as a browser sketch built from Web Audio nodes. The blocks
in `sk::wa` compute what those nodes compute, **sample for sample**, so a port
is a translation that can be checked against the sketch by comparing renders,
not a re-voicing by ear. They come with `<synthkit/synth.h>`.

| Block | Web Audio node | How to use it |
|---|---|---|
| `wa::BiquadFilter` | `BiquadFilterNode` | `prepare(sr)`, `setType(Type::Lowpass / Highpass / Bandpass / Lowshelf / Highshelf / Peaking / Notch / Allpass)`, `set(frequency, Q, gainDb = 0, detuneCents = 0)` (cheap to call every sample; recomputes only on change), `process(x)`, `flush()` once per block, `magnitude(hz)` / `phase(hz)` (`getFrequencyResponse`). Q is in dB for lowpass and highpass, as in Web Audio. One per channel. |
| `wa::DynamicsCompressor` | `DynamicsCompressorNode` | `prepare(sr)`, `set(thresholdDb, kneeDb, ratio, attack, release)` (defaults −24, 30, 12, 0.003, 0.25), `process(l, r)` in place (stereo, linked), `reduction()` (dB), `latency()` (the browsers' 6 ms look-ahead). |
| `wa::Convolver` | `ConvolverNode` | `setImpulse(channels, numChannels 1–2, length, irSampleRate, normalize = true)` (**allocates**: call it in `prepare` or before audio starts), then `process(l, r)` or `processMono(in, l, r)`. Zero latency, Web Audio's normalisation and channel routing. Costs a 64-tap direct head per sample plus FFT partitions; the most work in one sample is a few 8192-point FFTs. |
| `wa::PeriodicWave`, `wa::Oscillator` | `createPeriodicWave`, `OscillatorNode` | `wave.build(sr, real, imag, count, disableNormalization = false)` or `wave.build(sr, PeriodicWave::Basic::Sawtooth)` (**allocates**; one wave can feed many oscillators). `osc.prepare(sr)`, `osc.setWave(&wave)`, `osc.reset(phase0to1)`, `osc.next(hz)` per sample, with detune folded in: `hz * exp2(cents / 1200)`. |
| `wa::WaveShaper` | `WaveShaperNode` | `setCurve(curve, n)` (copies; **allocates**), `setOversample(Oversample::None / X2 / X4)`, `process(x)`. Oversampling uses the browsers' filters, so it has their latency (128 / 192 samples at 2× / 4×). |
| `wa::StereoPanner` | `StereoPannerNode` | `StereoPanner::process(pan, l, r)` (stereo input) or `processMono(pan, in, l, r)`. |
| `wa::Delay` | `DelayNode` | `prepare(sr, maxSeconds)`, `process(x, delaySeconds)` (write, then read; linear interpolation). |
| `wa::Param` | `AudioParam` | `Param p(default, min, max)`; `setValueAtTime`, `linearRampToValueAtTime`, `exponentialRampToValueAtTime`, `setTargetAtTime`, `setValueCurveAtTime(curve, n, t, duration)`, `cancelScheduledValues`, `cancelAndHoldAtTime`, `setValue(v)`; `valueAt(t)` per sample (times only move forward) or `fill(t0, dt, out, n)`. Times are seconds on the synth's own clock (keep a `double now` the way the sketch used `ctx.currentTime`). Room for 32 events and 256 curve points; `reserve(events, points)` in `prepare` for more. A full Param refuses an event (returns false) instead of allocating. |

Porting a node graph:

- **Gain, ConstantSource, connections into AudioParams** are just arithmetic:
  a gain node is a multiply, a `ConstantSourceNode` is a `wa::Param`, and a
  connection into a param adds to its value (`osc.next(freq * exp2((detune +
  wind) / 1200))`).
- **Per voice or global.** A node created per note becomes a member of the
  voice; one shared by all notes goes in the synth and runs in
  `processGlobal`. A node's channel count carries over: process each channel
  through its own block (biquads, shapers, delays), or use the stereo calls.
- **Where it can differ.** The browser renders in blocks of 128 and reads
  k-rate values once per block; these blocks read whatever you pass, when you
  pass it. Pass values per sample for a-rate behaviour, or hold them for 128
  samples where a sketch relied on k-rate timing. Chromium's x86 code steps
  ramps in single precision, so a *modulated* `DelayNode` agrees to about
  −58 dB rather than exactly.
- **Checking a port.** Render the sketch's graph in an `OfflineAudioContext`
  and the port with the same input, and compare. synthkit does this for every
  block (`tests/webaudio/parity.json`, checked in CI against Chromium):

  ```
  ./build/synthkit_wa_parity tests/webaudio/parity.json build/wa
  node web/test/webaudio-parity.cjs tests/webaudio/parity.json build/wa
  ```

  The two scripts are a template for a synth's own comparison with its sketch.

## 9. UI layout

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

| Top-level field | |
|---|---|
| `sections` | the panels, in order (below) |
| `theme` | `{ "accent": "#rrggbb" }`: the controls' colour (dark mode derives a lighter shade) |
| `keyboard` | `false` leaves out the on-screen keyboard and computer-key playing (default `true`) |
| `paramInfo` | info text per parameter ID (below) |

| Control field | |
|---|---|
| `param` | parameter ID |
| `type` | `knob` (floats, default), `slider`, `segmented` (choices with up to 4 options, default), `menu` (longer choices), `toggle` (toggles, default), `xy` (with `params: [x, y]`), or a custom widget name |
| `label` | text under the control (default: the parameter's name) |
| `size` | `small` or `large` knob |
| `info` | text for an ⓘ icon beside the label (also on `xy`) |

| Section field | |
|---|---|
| `title`, `controls` | a panel of controls |
| `kit` | a ready-made panel: `env1`, `env2`, … (with a live envelope drawing), `lfo1`, … (with a live preview), `shape1`, … (the curve editor), `modMatrix`, `voices` (mode, glide, unison, bend range), `master` (level, A4), and with `features.arp`: `arp` (type, then the arpeggiator's or sequencer's own controls), `arpPattern` (the piano roll, for whichever type is on), `arpEnv` and `arpPhrase` (the note and phrase envelopes, §4b) |
| `wide` | `true` makes the panel take a full row |
| `info` | text for an ⓘ icon beside the panel's title (kit panels too) |
| `collapsed` | makes the panel fold at its title: `true` starts folded, `false` starts open |

**Grouping panels.** Besides panels, `sections` (and the lists inside these)
can hold:

```json
{ "tabs": [
    { "title": "LFOs",   "sections": [ { "kit": "lfo1" }, { "kit": "lfo2" } ] },
    { "title": "Shapes", "sections": [ { "kit": "shape1" }, { "kit": "shape2" } ] }
] },
{ "accordion": [ { "kit": "voices", "collapsed": true }, { "kit": "master" } ], "single": true }
```

- `tabs`: a full-width row of tabs; only the chosen tab's sections show. Each
  tab needs a `title` and `sections` (any sections, including more tabs). A tab
  whose sections all turn out empty (kit panels the synth doesn't enable) is
  left out. Optional `title` on the group names it for screen readers.
- `accordion`: panels stacked in one column, each folding at its title (open
  unless the panel says `"collapsed": true`). `"single": true` keeps one open
  at a time; `"wide": true` gives it a full row. It holds panels only.
- The page remembers, per synth, which tab was chosen and which panels were
  folded (in the browser's storage, or the plugin's shared settings). A panel
  is known by its `title` (or `kit`), a tab group by its tab titles; give
  either an `id` to keep that memory across a rename.
- **Modulate…** opens whatever tab or folded panel hides the matrix.

**Info for any parameter** (`paramInfo`): a top-level map from parameter ID
to text, shown wherever that parameter's control appears, including in kit
panels and "More". A control's own `info` wins.

```json
"paramInfo": { "sk.a4": "Concert pitch: the frequency of the A above middle C." }
```

Info text is plain text (line breaks are kept). It shows on hover or keyboard
focus, and stays up after a click or tap until the next click elsewhere.

- Parameters the layout doesn't mention (other than kit and hidden ones) get a
  "More" panel, so nothing is unreachable. Mistakes in the layout (unknown
  parameter IDs or control types, malformed tabs) show as warnings when the
  page opens.
- Without a layout, a synth with both LFOs and shapes gets them in two tabs.
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
    // ctx.onMeter(sourceId, fn)    live value of any mod source (~30 times a second, playing or not)
    // ctx.send(messageId, ...values), ctx.onMessage(messageId, fn)   messages (§9b)
    // ctx.arpGenerate(settings)    a generated arp/sequencer pattern (§4b)
    // ctx.toast(text, kind)
  });
}
```

Then use `{ "type": "phraseView" }` as a control in the layout. Custom widgets
run identically in the browser and the plugin. A 128-key detune editor drawn
over a keyboard is the kind of thing they're for.

**Styles** (`ui/style.css`): loaded after the kit's styles, in the browser and
the plugin. The kit's colours are CSS variables (`--bg`, `--panel`, `--edge`,
`--ink`, `--ink-soft`, `--accent`, `--field`, `--track`, `--cap`, …), so a
synth can retheme everything, or style its own widgets and page (§9a).

## 9a. A synth's own page

When the kit's panels aren't the instrument (a cabinet with treadles, a
sequencer you draw in), a synth brings its own page and uses the kit's parts
only where it wants them. Add `ui/page.js`; the kit then builds no page of its
own and calls the page's `mount`:

```js
// ui/page.js
import { setupGauge } from "./page/gauge.js";

export function mount(sk, root) {
  sk.mount(root.querySelector(".presets-here"), "presets");
  sk.mount(root.querySelector(".keys-here"), "keyboard", { tempo: false });
  sk.mount(root.querySelector(".knobs"), "section", { title: "Voicing", controls: [{ param: "reed.bright" }] });
  setupGauge(sk, root.querySelector(".gauge"));
}
```

- `root` holds `ui/page.html`, if there is one (markup only: scripts in it
  don't run). Everything is still packed into the one HTML file, so the page
  works from a double-click, GitHub Pages and the plugin window alike.
- **Modules.** `page.js` can import other files under `ui/` (`./page/x.js`).
  They're joined into one scope rather than loaded, so: named imports and
  exports only (no `export default`, `import * as`, `import.meta` or packages),
  and a top-level name may be declared in only one file. `pack.py` says which
  rule a page breaks. A module should only define things when it loads; do
  the work in functions called from `mount` (load order follows imports, but
  circular imports are allowed).
- **Parts** (`sk.mount(element, name, options)`, which returns the part):

  | Name | Part |
  |---|---|
  | `presets` | the preset bar (pick, step, save, rename, delete, import, export) |
  | `keyboard` | the on-screen keyboard and wheels; computer keys play while it's on the page (`typing: false` to stop that). Its bar also takes the tempo and MIDI controls unless the page placed them (`tempo: false`, `midi: false`). |
  | `midi`, `tempo`, `output`, `panic`, `theme` | the Connect MIDI control, tempo controls (a readout in the plugin; `space: false` if the page uses Space itself), scope and level, Stop all sound, light/dark switch |
  | `hostbar` | the host bar (below), here instead of at the top of the page |
  | `panels` | panels for a whole layout (`{ sections: [...] }` as in layout.json; default: `ui/layout.json`) |
  | `section` | one panel, from one layout section (`{ title, controls }` or `{ kit: "env1" }`, `"modMatrix"`, `"shape1"`, …) |
  | `control` | one control, from one layout control (`{ param, type, label, size }`) |

- **The bridge** (`sk`):

  | | |
  |---|---|
  | `info` | `{ synth, params, messages, custom }` |
  | `get(id)`, `set(id, v)`, `norm(id)`, `setNorm(id, n)`, `format(id, v?)`, `parse(id, text)`, `reset(id)`, `param(id)`, `onParam(id, fn)`, `gesture(id, on)` | parameters (wrap a drag in `gesture` so a DAW records one automation move) |
  | `custom(id)`, `setCustom(id, v)`, `onCustom(id, fn)` | custom state (§5a) |
  | `send(id, ...values)`, `onMessage(id, fn)` | messages (§9b) |
  | `arpGenerate(settings)` | a generated arpeggiator or sequencer pattern (§4b) |
  | `onMeter(sourceId, fn)` | a mod source's value, ~30 times a second, whether or not anything is playing (a synth's own source makes a good gauge) |
  | `onMeters(fn)` | every meter frame (`voices`, `peak`, `beat`, `playing`, `bpm`, …) |
  | `noteOn(n, vel)`, `noteOff(n)`, `midi(bytes)`, `allNotesOff()`, `panic()` | playing (`allNotesOff()` and `panic()` also let go of keys held on the on-screen keyboard) |
  | `onMidi(fn)` | listen to Web MIDI input: `fn(bytes)` sees every message, and the synth still gets it |
  | `takeMidi(fn)` | take Web MIDI messages: when `fn(bytes)` returns `true`, the synth doesn't get that one (a page's own MIDI Learn, say). Anything else goes on |
  | `connectMidi()` | start Web MIDI without the button |
  | `transport()`, `onTransport(fn)` | the tempo the page shows: `{ bpm, num, den, playing, source }`, `source` being `daw`, `browser` or `midiClock` (§7) |
  | `hostBar(options)` | the host bar: `{ midi, tempo, panic, space }` set to `false` leave those out (`space: false`: Space doesn't start the clock); `hostBar(false)` leaves it out entirely |
  | `start()`, `running` | start the sound (browsers need a click first; the kit also starts it on any click or key) |
  | `presets.list()`, `current()`, `load(name, kind?)`, `save()`, `saveAs(name)`, `rename(name)`, `remove()`, `revert()`, `init()`, `exportFile()`, `importFile()`, `importPatch(patch)`, `onChange(fn)` | the kit's presets without its bar: `current()` is `{ name, kind, dirty }`, `kind` is `factory`, `user` or `session`. `importPatch` loads a patch object the page built (from an older format, say) and saves it as one of your presets under its name, made unique; it returns `{ ok, name, error, warnings }` |
  | `store.get(key, fallback)`, `store.set(key, value)` | the page's own settings (open drawers, a chosen view): kept per synth in the browser, or in the plugin's shared settings; never in patches |
  | `toast(text, kind)`, `menu(x, y, items)`, `host` | |

- **The host bar.** What a DAW would provide comes with every page: a prompt
  to start the sound (until it's running), Connect MIDI, the tempo controls
  and Stop all sound. Whatever the page doesn't place itself goes in a bar at
  the top of the page (or where it mounts `hostbar`), so a synth's own page
  can always be played from a MIDI keyboard and has a tempo. In the plugin the
  bar holds the DAW's tempo readout and Stop all sound. Leave parts out with
  `sk.hostBar({ tempo: false })` (an instrument without a clock; the
  keyboard's `tempo: false` means the same) or `sk.hostBar(false)`; restyle
  it with `.sk-hostbar` in `ui/style.css`.
- **Starting the sound.** Browsers only start audio during a click or key
  press. The kit starts it on any click or key until it's running. Messages
  and MIDI sent before then (from `mount`, or a MIDI keyboard played first)
  wait and are delivered once it starts; anything that tried to start the
  sound before the first click doesn't stop that click from starting it.
- The kit's computer-keyboard notes and Space for Play are off unless the page
  mounts the parts they belong to.
- [`examples/reed`](examples/reed) is a complete example: a walnut cabinet
  with a wind gauge and two treadles, built this way.

## 9b. Messages

Messages carry things between the page and the engine that aren't
parameters: a treadle being held, a "new reeds" button, the engine saying a
valve opened. They're not saved, not automatable and not in the host's
parameter list. A synth declares them:

```cpp
MessageId treadleLeft, valve;
void defineMessages(MessageBuilder& b) override {
  treadleLeft = b.add("treadle.left");   // the page sends this
  valve = b.add("wind.valve");           // the engine posts this
}

void processEvents(EventContext& ctx) override {
  for (auto& m : ctx.messages())
    if (m.is(treadleLeft)) leftDown = m.value() > 0.5f;   // m[0] … m[3], m.count
  for (auto& e : ctx.in()) ctx.out(e);
}

void processGlobal(GlobalContext& ctx, Buffer& io) override {
  if (opened) ctx.post(valve, {1});      // also ctx.post from processEvents
}
```

and the page (or a custom widget) sends and listens: `sk.send("treadle.left",
1)`, `sk.onMessage("wind.valve", (open) => …)`.

- A message is an id and up to four numbers. Ids use letters, digits, `.`, `-`
  and `_`, and are only used between the synth and its own page, so renaming
  one is fine.
- The engine sees each incoming message once, in `ctx.messages()` at the start
  of the next block (in the plugin, the host's next block). Keep what it means
  in the synth (`leftDown`), not in the message. A message sent before the
  sound has started waits, and is delivered when it starts (at the first
  click or key press, §9a).
- Posted messages reach the page within a block in the browser and within
  about 30 ms in the plugin. Post on changes, not every block: queues hold 255
  messages each way, and `post` returns false (and the stats count a drop)
  when one is full.
- Both directions are lock-free and allocation-free on the audio thread.
- Render scenarios (§10) can send them: `{ "t": 0.5, "msg": "treadle.left",
  "values": [1] }`.

## 10. Testing a synth

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
| `events` | time in seconds (`t`) or beats (`beat`); `on`/`off` (+`vel` 0–127, `ch`), `cc` + `value` (0–127), `bend` (−1…1), `at` (0–127), or `msg` + `values` (a message from the page, §9b; the render splits its block there, so the result doesn't depend on block size) |

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

**In the browser** (`web/test/browser-test.cjs`, run by every synth's CI),
the page is also played the way a person does: under a real browser's
autoplay rule (emulated, since headless Chromium doesn't enforce it) the first
click must start the sound, even after something tried to start it before;
the page must offer Connect MIDI; a (fake) MIDI keyboard must play it; and
each parameter's `cc()` mapping must move it and show on the page.

**Commands** (built as `<name>_render`):

```
basic_render --check examples/basic --out renders   # everything above; WAVs into renders/
basic_render examples/basic/tests/chord.json --out chord.wav [--sr 96000] [--block 64]
basic_render --params                                # list every parameter
```

CI runs `--check` on every PR and attaches the rendered WAVs.

## 11. The browser build

```
cmake -S . -B build-web -G Ninja -DCMAKE_TOOLCHAIN_FILE=synthkit/cmake/wasm32-wasi.cmake
cmake --build build-web          # → build-web/web/<name>.html
```

This needs clang 18+, `lld` and the wasm32 sysroot (Linux only). On Ubuntu,
`synthkit/tools/ci/deps.sh web` installs them, as CI does.

The result is **one self-contained HTML file** with the synth (WebAssembly),
the UI, the layout, `ui/style.css`, the synth's own page if it has one (§9a)
and the presets inside. It runs from a double-click (`file://`), from GitHub
Pages, or from anywhere else, with no server. The kit's page has the preset
bar (factory presets, your own presets saved in the browser, import and export
as files), a keyboard you can play with the mouse, touch or computer keys
(keys light while they're held, from there or from a MIDI controller, and
letting go always ends the note, even with a modifier down or the focus moved
into a text field),
pitch and mod wheels, Web MIDI input with MIDI learn, a tempo clock (play, BPM,
time signature), a scope, a level meter and a voice count; a synth's own page
has whichever of these it mounts. The current sound is restored when you come
back.

The audio engine is the same C++ as the plugin's, so the browser plays exactly
what the plugin will. CI renders a scenario (messages included) through the
page's real AudioWorklet and fails if any 100 ms of it differs from the
native render by more than −40 dB (in practice they agree to −75 dB or
better).

**Rules this adds for synth code:** it must compile without C++ exceptions
(no `throw`, `try` or `catch`) and without threads. Report definition-time
mistakes with `sk::fail("message")`, which throws in native builds and stops
with the message in the browser.

## 12. Plugins

```
cmake -S . -B build-plugin -DSYNTHKIT_PLUGIN=ON -DSYNTHKIT_WEB_UI_DIR=build-web/web
cmake --build build-plugin --config Release --target mysynth_plugin_VST3
```

`synthkit_add_synth` then also builds, with JUCE (fetched at a pinned version;
`-DFETCHCONTENT_SOURCE_DIR_JUCE=…` uses a local copy):

| Target | What | For |
|---|---|---|
| `<name>_plugin_VST3` | `<Name>.vst3` | Ableton Live (Windows, Mac), Reaper |
| `<name>_plugin_AU` (macOS) | `<Name>.component` | GarageBand, Logic |
| `<name>_plugin_Standalone` | an app with its own audio/MIDI settings | playing without a DAW |
| `<name>_plugin_check` | loads the VST3 like a DAW and checks it against the engine | CI |

Nothing in the synth changes for the plugin:

- **Parameters** are the host's automatable parameters, with the same IDs,
  names, ranges and text. Parameters marked `hidden` aren't automatable.
  Dragging a control in the plugin window is recorded as one automation gesture.
- **The DAW project stores the patch** (§5), wrapped as
  `{"format": "synthkit-plugin-state", "version": 1, "patch": {…}, "ui": {…}}`
  (`ui` notes which preset the window shows). A bare patch JSON also loads.
- **Tempo, play position and time signature** come from the host (§7). When
  the host has no position (some hosts while stopped), the kit's own clock runs
  at the host's tempo.
- **MIDI** comes from the host track: notes, pitch bend, mod wheel, sustain and
  other CCs, aftertouch. (For VST3 the host sends CCs as hidden parameters;
  the plugin turns them back into MIDI.)
- **A new instance** starts on `presets/init.json` when there is one.

**The plugin window is the browser page** (§11) in a web view (WebView2 on
Windows, WebKit on macOS and Linux). Build the page first and point
`SYNTHKIT_WEB_UI_DIR` at it; without it the plugin gets JUCE's plain parameter
list instead. Layout, custom widgets, styles (§9), a synth's own page (§9a)
and messages (§9b) work unchanged. In the plugin:

- the tempo area shows the DAW's tempo and time signature (no Play button, no
  Web MIDI, no MIDI learn: map controllers with the DAW's own MIDI mapping);
  on a synth's own page, `sk.mount(el, "midi")` places nothing and
  `sk.onMidi` sees nothing, since the DAW routes MIDI to the plugin (the
  engine's `cc()` mappings and `ctx.setParam` still work, and the host
  records the moves as automation gestures);
- your presets, theme, keyboard settings and a page's `sk.store` settings
  are shared by every instance of the synth on the computer (`%APPDATA%\synthkit\<id>\settings.json`,
  `~/Library/Application Support/synthkit/<id>/settings.json`), and Export /
  Import use the system's file dialogs;
- the on-screen keyboard plays through the plugin; meters and modulation rings
  show the plugin's output;
- messages reach the engine at its next block, and its posts reach the page
  about 30 times a second.

The page is packed as pure ASCII (non-ASCII is escaped), because some web
views ignore the declared character set.

CI builds the plugins for Windows, macOS (universal, with the AU) and Linux on
every PR. It runs `<name>_plugin_check` and
[pluginval](https://github.com/Tracktion/pluginval) at strictness 10 (and
`auval` for the AU), and attaches a zip per OS with install notes. A version
tag (`v0.2.0`) publishes the zips as a GitHub release. Builds aren't
code-signed: macOS needs the one-time `xattr` step in the install notes.

## 13. Targets

| Target | Used in |
|---|---|
| Web (WASM + AudioWorklet, single HTML file) | development, quick play |
| VST3 (Windows, macOS, Linux) | Ableton Live, Reaper |
| AU (macOS) | GarageBand, Logic, Reaper |
| Standalone app | playing without a DAW |

CLAP isn't built (Live 11 doesn't load it); it could be added later for
Reaper or Bitwig.
