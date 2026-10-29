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
| 1 | `API.md`, `CLAUDE.md` (this PR) | review the contract |
| 2 | core library, DSP blocks, example synth, render tool, Linux CI | listen to rendered WAVs on the PR |
| 3 | web adapter, UI components, Web MIDI, presets, Pages deploy | play the example synth in the browser |
| 4 | mod matrix, tempo-synced LFOs, MIDI clock | build richer patches |
| 5 | JUCE plugin adapter, Windows/macOS CI, pluginval, releases | load it in Live / GarageBand |
| 6 | synth template + scaffold script | start a new synth in one step |

After phase 6: port the aleatoric synth into its own repo using only `API.md`,
as the real test of the kit.
