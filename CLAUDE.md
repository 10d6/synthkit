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
   standard library only. Platform code lives in `web/` and `plugin/`. The
   plugin window is the web page, so UI work happens once, in `web/shell/`.
3. **Real-time safety.** No allocation, locks, I/O or exceptions on the audio
   thread (`start`, `release`, `render`, `processGlobal`, `processEvents`). Allocate in
   `prepare`. Core and synth code never `throw`/`catch` at all (the browser
   build has no exceptions); use `sk::fail(msg)` for definition errors and
   `Json::tryParse` for input that may be malformed.
4. **Stable identifiers.** Parameter IDs, `synth.json` `id`, `pluginCode` and
   `vendorCode` never change once released. Patches store real units, not
   normalised values.
5. **Build for synths that exist.** A feature goes into the kit when a second
   synth needs it. Until then it lives in the synth repo. Gaps a synth repo
   finds in `API.md` get fixed here, in the doc or the kit.
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
                         (what adapters use), params, json, custom, messages
                         (page <-> engine, API.md §9b), dsp/…, webaudio/…
                         (sk::wa: Web Audio's nodes, API.md §8a)
core/src/                engine.cpp (voices, events, transport), modulation.cpp
                         (sources, matrix, LFOs, shapes), params, json
cmake/                   synthkit_add_synth() + preset embedding
tools/render/            <synth>_render: scenarios, generic checks, WAV output
tools/wa_parity/         synthkit_wa_parity: renders tests/webaudio with sk::wa
examples/basic/          subtractive synth exercising the whole API
examples/reed/           pump organ with its own page (ui/page.*), messages
                         (treadles) and sk::wa blocks
tests/core_tests.cpp     kit unit tests (no framework; TEST/CHECK macros)
tests/webaudio/          sk::wa parity scenarios; tools/wa_parity renders them
                         natively, web/test/webaudio-parity.cjs in Chromium
web/wasm/                C API exported to JavaScript
web/shell/               the page: template, style, js/ (model, audio, host
                         (plugin bridge), controls, panels, modulation, presets,
                         keyboard, midi, clock, app; app.js also holds the
                         bridge for a synth's own page), worklet.js
web/pack.py              inlines everything into one <synth>.html (and joins a
                         synth's ui/page.js modules into one scope)
web/test/                headless Chromium tests (page; page's plugin mode; a
                         synth's own page, page-test.cjs) + browser-vs-native
                         compare + sk::wa parity
plugin/                  JUCE adapter: Processor (engine, params, state,
                         transport), Editor (web view + page bridge), Settings
                         (shared store), test/PluginCheck (DAW-style check)
cmake/plugin.cmake       JUCE fetch (pinned) + <name>_plugin targets
template/                a new synth repo ({{PLACEHOLDERS}}); tools/new-synth.py
                         copies it, fills it in and pins synthkit as a submodule
tools/ci/                deps.sh, plugin.sh: CI steps shared by synthkit and
                         every synth repo (pinned with the submodule)
```

## Fresh workspace

A new session's workspace has none of the toolchains. Install them first
(Ubuntu; the same script CI uses, safe to re-run):

```
tools/ci/deps.sh native && tools/ci/deps.sh web && tools/ci/deps.sh plugin
```

Chromium and Playwright are usually preinstalled in the cloud workspace
(`NODE_PATH=$(npm root -g) node …` if `require("playwright")` fails); if not,
`npm install --no-save playwright@1.48.2 && npx playwright install --with-deps chromium`.
pluginval: download `pluginval_Linux.zip` from
https://github.com/Tracktion/pluginval/releases. JUCE is fetched by CMake (or
`git clone --depth 1 --branch 9.0.4 https://github.com/juce-framework/JUCE
/tmp/juce9` once and pass `-DFETCHCONTENT_SOURCE_DIR_JUCE=/tmp/juce9` to save
time). The browser build is Linux-only (Ubuntu's wasm32 packages).

## Starting a new synth (in a new conversation)

The owner creates an empty GitHub repo and gives the session access to it and
to synthkit, plus the synth's design (an earlier chat, a sketch, a description).
Then:

1. Clone synthkit and the new repo; set up the workspace (above).
2. `python3 synthkit/tools/new-synth.py <new repo> --name "…" --plugin-code Xxxx`
   (run `--help`; the codes are permanent, so choose them with the owner if
   unsure). Commit the untouched scaffold to `main` so PRs have a base.
3. Build the synth on a branch, working from `API.md` only, and open a PR.
   Anything API.md lacks goes into a synthkit PR (doc fix or kit change), and
   the synth's submodule moves to it.
4. Remind the owner to turn on Pages (Settings → Pages → `gh-pages` / root)
   for the preview link.

## Commands

```
cmake -S . -B build -G Ninja && cmake --build build
./build/synthkit_tests                                        # kit unit tests
./build/examples/basic/basic_render --check examples/basic --out build/renders
./build/examples/basic/basic_render examples/basic/tests/chord.json --out x.wav
```

Browser build (`tools/ci/deps.sh web`):

```
cmake -S . -B build-web -G Ninja -DCMAKE_TOOLCHAIN_FILE=cmake/wasm32-wasi.cmake && cmake --build build-web
node web/test/browser-test.cjs build-web/web/basic.html build-web/test examples/basic/tests/demo-pump.json --kit-ui
./build/examples/basic/basic_render examples/basic/tests/demo-pump.json --block 128 --out build-web/test/native.wav
python3 web/test/compare.py build-web/test/web-render.f32 build-web/test/native.wav
```

Web Audio blocks (`sk::wa`, API.md §8a) against Chromium's own nodes:

```
cmake --build build --target synthkit_wa_parity && mkdir -p build/wa
./build/synthkit_wa_parity tests/webaudio/parity.json build/wa
node web/test/webaudio-parity.cjs tests/webaudio/parity.json build/wa
```

Changing an `sk::wa` block means it must still match the browser: run these,
and add a case to `tests/webaudio/parity.json` for anything new. The blocks
follow Chromium's code (BSD; notice in `core/include/synthkit/webaudio.h`), so
when they disagree, read Chromium's `third_party/blink/renderer/platform/audio`
and `modules/webaudio` rather than tuning numbers.

A synth's own page (API.md §9a) and messages (§9b), with examples/reed:

```
./build/examples/reed/reed_render --check examples/reed
node web/test/page-test.cjs build-web/web/reed.html build-web/test-reed
node web/test/browser-test.cjs build-web/web/reed.html build-web/test-reed examples/reed/tests/pump.json
./build/examples/reed/reed_render examples/reed/tests/pump.json --block 128 --out build-web/test-reed/native.wav
python3 web/test/compare.py build-web/test-reed/web-render.f32 build-web/test-reed/native.wav
```

Plugins (needs the page built first; `tools/ci/deps.sh plugin`):

```
node web/test/plugin-ui-test.cjs build-web/web/basic.html build-web/test   # page <-> plugin messages
cmake -S . -B build-plugin -G Ninja -DSYNTHKIT_PLUGIN=ON -DSYNTHKIT_WEB_UI_DIR=$PWD/build-web/web \
  [-DFETCHCONTENT_SOURCE_DIR_JUCE=/tmp/juce9] && cmake --build build-plugin
xvfb-run -a build-plugin/examples/basic/basic_plugin_check_artefacts/Release/basic_plugin_check \
  "build-plugin/examples/basic/basic_plugin_artefacts/Release/VST3/synthkit Basic.vst3"
xvfb-run -a pluginval --strictness-level 10 --validate-in-process "<same .vst3>"
```

New synth repo from the template (`--link-synthkit` symlinks instead of a
submodule, for testing the template against this checkout):

```
python3 tools/new-synth.py /tmp/newsynth --name "Glass Rain" --link-synthkit .
```

The template is checked in CI (the "Template synth" job). Template changes are
API changes for synth repos: keep API.md §1 in step.

The standalone runs under Xvfb (`~/.asoundrc` with `pcm.!default { type null }`
gives it an audio device); screenshot with ImageMagick `import -window root`.

The browser test writes screenshots (desktop, phone, dark) to `build-web/test/`.
Look at them after any UI change. Emscripten can't be installed here (its
download host is blocked); the browser build uses plain clang + wasi-libc.

The browser test emulates a real browser's autoplay rule. Playwright's
`evaluate()` and `waitForFunction()` count as user gestures (for a few
seconds), so a test of "nothing may start before a click" must not touch the
page until it clicks.

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

JUCE is used only in `plugin/` (under JUCE's Starter or AGPLv3 terms).
Everything else must stay JUCE-free so it can be
licensed independently. It's our own code, except that the `sk::wa` blocks
(`core/include/synthkit/webaudio/`) follow Chromium's Web Audio code, which is
BSD-licensed: keep its notice in `webaudio.h`, and when a license is chosen
the plugin zips and release notes need that notice too. No license chosen yet.

## CI

The repo is public, with GitHub Pages serving the `gh-pages` branch: CI
publishes `main` at https://10d6.github.io/synthkit/ and each PR at
`/pr/<number>/` (with examples/reed at `…/reed.html`), and comments the link
on the PR. On every PR: Linux build + tests (release and sanitizers, both
examples' `--check`), the browser build, the kit's page and plugin-mode tests,
the reed's own-page test, browser-vs-native comparisons for both examples, and
the `sk::wa` parity check against Chromium. Plugin
builds run on every PR too: Windows, macOS (universal + AU) and Linux, each
with `<name>_plugin_check` and pluginval (auval on macOS), uploading a zip per
OS (`synthkit-basic-<os>`) for the owner to install. A `v*` tag makes a
GitHub release from those zips. The Windows job gets the WebView2 SDK from
NuGet. The plugin steps live in `tools/ci/` so synth repos run the same ones.
A "Template synth" job scaffolds a synth from `template/` and runs its native,
browser and Linux plugin checks.
