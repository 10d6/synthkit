# synthkit — notes for Claude

synthkit is a shared foundation for software synths. Each synth lives in its
own repo, pulls synthkit in as a pinned submodule, and ships as a web app
(for quick iteration) and as VST3/AU plugins (for use in a DAW).

The owner plays synths and gives feedback; Claude writes the code and opens
PRs. The owner tests via the GitHub Pages build of each PR, and installs plugin
builds from CI artifacts at milestones.

## Ground rules

1. **`API.md` is the contract.** Synth work should only need `API.md` plus the
   synth's own repo. Any PR that changes the public API updates `API.md` in the
   same PR. If you catch yourself reading kit source to build a synth, the doc
   is missing something — fix the doc.
2. **`core/` has no dependencies on JUCE or the browser.** Plain C++20 and the
   standard library only. Platform code lives in `web/` and `plugin/`.
3. **Real-time safety.** No allocation, locks, I/O or exceptions on the audio
   thread (`start`, `release`, `render`, `processGlobal`, `processEvents`). Allocate in
   `prepare`. Core and synth code never `throw`/`catch` at all (the browser
   build has no exceptions); use `sk::fail(msg)` for definition errors and
   `Json::tryParse` for input that may be malformed.
4. **Stable identifiers.** Parameter IDs, `synth.json` `id`, `pluginCode` and
   `vendorCode` never change once released. Patches store real units, not
   normalised values.
5. **Build for synths that exist.** A feature goes into the kit when a second
   synth needs it. Until then it lives in the synth repo.
6. **Expect unusual synths.** The owner's synths often have very custom
   behaviour (per-note detune tables, self-generating note sequences,
   note-triggered tempo-locked modulation). Musical time — beats, bars, time
   signature — is a first-class input alongside velocity and pitch. Kit
   defaults must always be overridable through the escape hatches and custom
   state in `API.md` — never design a kit feature that forces one way of doing
   things without a way out.
7. **Verify by rendering.** Every DSP or engine change is checked with the
   offline render tool (`tools/render`) before a PR: no NaN/inf, no clipping,
   no unexpected silence, presets round-trip. Attach rendered WAVs or the web
   preview link when the change is audible.

## Layout

```
core/include/synthkit/   public headers: synth.h (what synths use), engine.h
                         (what adapters use), params, json, custom, dsp/…
core/src/                engine.cpp (voices, events, transport), modulation.cpp
                         (sources, matrix, LFOs, shapes), params, json
cmake/                   synthkit_add_synth() + preset embedding
tools/render/            <synth>_render: scenarios, generic checks, WAV output
examples/basic/          subtractive synth exercising the whole API
tests/core_tests.cpp     kit unit tests (no framework; TEST/CHECK macros)
web/wasm/                C API exported to JavaScript
web/shell/               the page: template, style, js/ (model, audio, controls,
                         panels, modulation, presets, keyboard, midi, clock, app),
                         worklet.js
web/pack.py              inlines everything into one <synth>.html
web/test/                headless Chromium test + browser-vs-native compare
plugin/, template/       phases 5, 6
```

## Commands

```
cmake -S . -B build -G Ninja && cmake --build build
./build/synthkit_tests                                        # kit unit tests
./build/examples/basic/basic_render --check examples/basic --out build/renders
./build/examples/basic/basic_render examples/basic/tests/chord.json --out x.wav
```

Browser build (needs `clang-18 lld-18 wasi-libc libc++-18-dev-wasm32
libclang-rt-18-dev-wasm32`, already installed if this workspace did phase 3):

```
cmake -S . -B build-web -G Ninja -DCMAKE_TOOLCHAIN_FILE=cmake/wasm32-wasi.cmake && cmake --build build-web
node web/test/browser-test.cjs build-web/web/basic.html build-web/test examples/basic/tests/demo-pump.json
./build/examples/basic/basic_render examples/basic/tests/demo-pump.json --block 128 --out build-web/test/native.wav
python3 web/test/compare.py build-web/test/web-render.f32 build-web/test/native.wav
```

The browser test writes screenshots (desktop, phone, dark) to `build-web/test/`.
Look at them after any UI change. Emscripten can't be installed here (its
download host is blocked); the browser build uses plain clang + wasi-libc.

Run the native checks before every PR. For DSP changes, also look at the renders
(spectrograms show clicks as vertical lines) and run a sanitizer build:
`-DCMAKE_BUILD_TYPE=Debug -DCMAKE_CXX_FLAGS="-fsanitize=address,undefined"`
(use GCC; clang's ASan runtime isn't installed in the workspace).

## Targets

- Owner's main setup: **Windows + Ableton Live 11** → VST3 is the primary
  plugin target; Windows CI matters most. (Live 11 has no CLAP support.)
- Occasional **macOS + GarageBand** → AU (GarageBand loads AU only).
- Reaper may be used later (loads VST3/AU; CLAP optional).

## Licensing

JUCE is used only in `plugin/` (free Starter tier while private; AGPLv3 or
Starter once public). Everything else is our own code and must stay JUCE-free
so it can be licensed independently. No license chosen yet.

## CI

The repo is public, with GitHub Pages serving the `gh-pages` branch: CI
publishes `main` at https://10d6.github.io/synthkit/ and each PR at
`/pr/<number>/`, and comments the link on the PR. Linux build + tests, the
browser build and the browser-vs-native comparison run on every PR. Plugin
builds (phase 5) should run on every PR too, now that Actions minutes are free.

## Status

See README → Roadmap. Phases 1–4 are done (contract; core, DSP, render tool,
example synth; browser build; modulation). Next: **phase 5 — JUCE plugin
adapter (VST3 for Live on Windows first, AU for GarageBand)**.
