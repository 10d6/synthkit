# synthkit

A shared foundation for building software synths once and running them in two
places:

- **in the browser**, for fast iteration (each PR gets a playable link), and
- **as VST3 / AU plugins**, for use in a DAW (Ableton Live, Reaper, GarageBand).

A synth built on synthkit provides only what's unique to it: its parameters,
its sound engine and its control layout (or a page of its own). synthkit
handles MIDI, voices, patches and presets, modulation routing, tempo sync, the
UI controls, messages between the page and the engine, testing and the builds.
For synths that start as Web Audio sketches, it has DSP blocks that match the
browser's nodes sample for sample, so a sketch ports by translation.

**Start here:** [`API.md`](API.md) describes what a synth looks like to write.
[`examples/basic`](examples/basic) is a complete synth built on it, and
[`examples/reed`](examples/reed) one with its own page.

```
cmake -S . -B build && cmake --build build
./build/examples/basic/basic_render --check examples/basic --out renders
```

renders every test scenario and preset to `renders/` and runs the kit's checks.

## Playing it in the browser

CI publishes `main` at <https://10d6.github.io/synthkit/> and each PR at
`https://10d6.github.io/synthkit/pr/<number>/` (the reed example is
`…/reed.html`), and links the preview on the PR. Each PR's CI run also has a
**web-basic** artifact with the same pages as files: unzip and double-click
`basic.html` or `reed.html`. Each is the whole synth in one file, with no
server needed.

Click once to start the sound, then play with the mouse, your computer
keyboard (A–K), or a MIDI keyboard (**Connect MIDI**).

To build it yourself (Ubuntu; `tools/ci/deps.sh web` installs clang 18 and the
wasm32 sysroot):

```
cmake -S . -B build-web -G Ninja -DCMAKE_TOOLCHAIN_FILE=cmake/wasm32-wasi.cmake
cmake --build build-web        # → build-web/web/basic.html, reed.html
```

## Starting a new synth

```
python3 tools/new-synth.py ../my-synth --name "Glass Rain"
```

makes a synth repo that builds, passes every check and has CI ready: browser
previews and plugin zips on every PR. See [`API.md`](API.md) §1.

## Using it in your DAW

Every PR's CI run also has a plugin zip per system: **synthkit-basic-windows**,
**synthkit-basic-macos** (VST3 + AU, Intel and Apple Silicon) and
**synthkit-basic-linux**. Each has the plugin, a standalone app and
`INSTALL.md`. On Windows, copy the `.vst3` folder to
`C:\Program Files\Common Files\VST3\` and rescan in Live. On a Mac, see
`INSTALL.md` for the one Terminal command unsigned plugins need. Tagging a
version (`v0.2.0`) publishes the zips as a GitHub release.

The plugin window is the same page as the browser version, including a
synth's own page. The sound is saved in your DAW project, and your own
presets are shared by every copy of the synth on the computer.

## How it fits together

```
   your synth (params + voice + layout.json, or its own ui/page.js)
                          │
                    synthkit core          portable C++: params, voices,
                          │                mod matrix, patches, messages,
                          │                DSP blocks (incl. sk::wa: Web Audio's nodes)
            ┌─────────────┴─────────────┐
        web adapter                plugin adapter
   WASM + AudioWorklet           JUCE → VST3 / AU
   HTML UI, Web MIDI             same HTML UI in a WebView
   (kit page or synth's own)
   GitHub Pages                  CI builds for Windows / macOS / Linux
```
