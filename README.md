# synthkit

A shared foundation for building software synths once and running them in two
places:

- **in the browser**, for fast iteration (each PR gets a playable link), and
- **as VST3 / AU plugins**, for use in a DAW (Ableton Live, Reaper, GarageBand).

A synth built on synthkit provides only what's unique to it: its parameters,
its sound engine and its control layout. synthkit handles MIDI, voices,
patches and presets, modulation routing, tempo sync, the UI controls, testing
and the builds.

**Start here:** [`API.md`](API.md) describes what a synth looks like to write.
[`examples/basic`](examples/basic) is a complete synth built on it.

```
cmake -S . -B build && cmake --build build
./build/examples/basic/basic_render --check examples/basic --out renders
```

renders every test scenario and preset to `renders/` and runs the kit's checks.

## Playing it in the browser

Every PR's CI run has a **web-basic** artifact: download it, unzip, and
double-click `basic.html`. It's the whole synth in one file, with no server
needed. Click once to start the sound, then play with the mouse, your computer
keyboard (A–K), or a MIDI keyboard (**Connect MIDI**).

To build it yourself (Ubuntu 24.04: `sudo apt install clang-18 lld-18 wasi-libc
libc++-18-dev-wasm32 libclang-rt-18-dev-wasm32`):

```
cmake -S . -B build-web -G Ninja -DCMAKE_TOOLCHAIN_FILE=cmake/wasm32-wasi.cmake
cmake --build build-web        # → build-web/web/basic.html
```

**Preview links.** Once the repo is public, CI also publishes each PR to
`https://10d6.github.io/synthkit/pr/<number>/` (and `main` at the site root) and
links it on the PR. It needs one setting: Settings → Pages → Build and
deployment → Deploy from a branch → `gh-pages` / root.

## Using it in your DAW

Every PR's CI run also has a plugin zip per system: **synthkit-basic-windows**,
**synthkit-basic-macos** (VST3 + AU, Intel and Apple Silicon) and
**synthkit-basic-linux**. Each has the plugin, a standalone app and
`INSTALL.md`. On Windows, copy the `.vst3` folder to
`C:\Program Files\Common Files\VST3\` and rescan in Live. On a Mac, see
`INSTALL.md` for the one Terminal command unsigned plugins need. Tagging a
version (`v0.2.0`) publishes the zips as a GitHub release.

The plugin window is the same page as the browser version. The sound is saved
in your DAW project, and your own presets are shared by every copy of the synth
on the computer.

## How it fits together

```
          your synth (params + voice + layout.json)
                          │
                    synthkit core          portable C++: params, voices,
                          │                mod matrix, patches, DSP blocks
            ┌─────────────┴─────────────┐
        web adapter                plugin adapter
   WASM + AudioWorklet           JUCE → VST3 / AU
   HTML UI, Web MIDI             same HTML UI in a WebView
   GitHub Pages                  CI builds for Windows / macOS
```

## Roadmap

| Phase | Delivers | You can… |
|---|---|---|
| 1 ✓ | `API.md`, `CLAUDE.md` | review the contract |
| 2 ✓ | core library, DSP blocks, example synth, render tool, Linux CI | listen to rendered WAVs on the PR |
| 3 ✓ | browser build (one HTML file), UI from layout.json, Web MIDI, presets, previews | play the example synth in the browser |
| 4 ✓ | mod matrix, LFOs, drawn tempo-locked shapes, musical-time sources, MIDI clock | build richer, tempo-aware patches |
| 5 ✓ | JUCE plugin adapter (VST3, AU, Standalone; the page as its window), Windows/macOS/Linux CI, pluginval, releases | load it in Live / GarageBand |
| 6 | synth template + scaffold script | start a new synth in one step |

After phase 6: port the aleatoric synth into its own repo using only `API.md`,
as the real test of the kit.
