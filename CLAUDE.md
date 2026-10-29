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
   thread (`start`, `release`, `render`, `processGlobal`, `onMidi`). Allocate in
   `prepare`.
4. **Stable identifiers.** Parameter IDs, `synth.json` `id`, `pluginCode` and
   `vendorCode` never change once released. Patches store real units, not
   normalised values.
5. **Build for synths that exist.** A feature goes into the kit when a second
   synth needs it. Until then it lives in the synth repo.
6. **Verify by rendering.** Every DSP or engine change is checked with the
   offline render tool (`tools/render`) before a PR: no NaN/inf, no clipping,
   no unexpected silence, presets round-trip. Attach rendered WAVs or the web
   preview link when the change is audible.

## Layout (planned)

```
core/      params, voice, mod, dsp, midi, patch   (portable C++)
web/       worklet (WASM), ui components, host shell
plugin/    JUCE adapter: VST3/AU, WebView UI
tools/     render CLI, scaffold script
examples/  basic subtractive synth used to test the kit
template/  starting point for new synth repos
```

## Targets

- Owner's main setup: **Windows + Ableton Live** → VST3 is the primary plugin
  target; Windows CI matters most.
- Occasional **macOS + GarageBand** → AU (GarageBand loads AU only).
- Reaper may be used later (loads VST3/AU; CLAP optional).

## Licensing

JUCE is used only in `plugin/` (free Starter tier while private; AGPLv3 or
Starter once public). Everything else is our own code and must stay JUCE-free
so it can be licensed independently. No license chosen yet.

## CI

The repo is private for now: run Linux build + tests on every PR; Windows and
macOS plugin builds are `workflow_dispatch` (manual) to save Actions minutes.
Switch them to automatic when the repo goes public.

## Status

See README → Roadmap. Current phase: **1 — contract (docs only)**.
