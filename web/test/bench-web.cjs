// How fast the browser build runs: renders a scenario offline through the
// page's real AudioWorklet (WASM) in headless Chromium and reports how many
// times faster than realtime it went. The render tool reports native speed;
// the browser is usually the slower of the two, and the one people play.
//
//   node web/test/bench-web.cjs <synth.html> <scenario.json> [runs]
//
// The scenario is the render tool's format (API.md §10): patch (a preset name
// or path, or an inline patch), params, transport, events in seconds or
// beats, length or lengthBeats. The best of `runs` (default 3) is reported.
// The machine's speed varies, so compare builds on the same machine.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

(async () => {
  const [html, scenarioPath, runsArg] = process.argv.slice(2);
  if (!html || !scenarioPath) {
    console.error("usage: node bench-web.cjs <synth.html> <scenario.json> [runs]");
    process.exit(2);
  }
  const runs = Number(runsArg || 3);
  const sc = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("file://" + path.resolve(html));
  await page.waitForFunction(() => window.synthkit && window.synthkit.model);
  const res = await page.evaluate(async ({ sc, runs }) => {
    const sk = window.synthkit;
    const name = sc.patch === undefined ? "init" : sc.patch;
    let patch = name;
    if (typeof name === "string") {
      const base = name.replace(/\.json$/, "").split("/").pop();
      const preset = sk.model.info.presets.find((p) => p.path.endsWith("/" + base + ".json"));
      if (!preset) throw new Error(`no preset named ${name}`);
      patch = preset.patch;
    }
    if (!sk.model.loadPatch(patch).ok) throw new Error("patch load failed");
    for (const [k, v] of Object.entries(sc.params || {})) sk.model.set(k, v);
    // The scenario's tempo, else the patch's (features.tempoInPatch), else 120,
    // as the render tool does.
    const pt = sk.model.info.synth.tempoInPatch ? sk.model.patchTempo() : null;
    const tr = sc.transport || {};
    const bpm = tr.bpm || (pt && pt.bpm) || 120;
    const toSec = (e) => (e.beat !== undefined ? (e.beat * 60) / bpm : e.t);
    const midi = (e) => {
      const ch = Math.max(0, Math.min(15, (e.ch || 1) - 1));
      if (e.on !== undefined) return [0x90 | ch, e.on, e.vel ?? 100];
      if (e.off !== undefined) return [0x80 | ch, e.off, 64];
      if (e.cc !== undefined) return [0xb0 | ch, e.cc, e.value];
      if (e.bend !== undefined) {
        const v = Math.max(0, Math.min(16383, Math.round(8192 + e.bend * 8191)));
        return [0xe0 | ch, v & 127, v >> 7];
      }
      if (e.at !== undefined) return [0xd0 | ch, e.at, 0];
      return null;
    };
    const events = [];
    for (const e of sc.events || []) {
      if (e.msg !== undefined) events.push({ t: toSec(e), m: [sk.model.info.messages.indexOf(e.msg), e.values || []] });
      else { const d = midi(e); if (d) events.push({ t: toSec(e), d }); }
    }
    const seconds = sc.lengthBeats ? (sc.lengthBeats * 60) / bpm : sc.length;
    const transport = { bpm, playing: !!tr.playing, num: (tr.timeSig || [pt ? pt.num : 4])[0], den: (tr.timeSig || [4, pt ? pt.den : 4])[1] };
    const times = [];
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      await sk.renderOffline({ events, seconds, sampleRate: sc.sampleRate || 48000, transport });
      times.push((performance.now() - t0) / 1000);
    }
    return { seconds, times };
  }, { sc, runs });
  await browser.close();
  const best = Math.min(...res.times);
  console.log(`${path.basename(scenarioPath)}: ${res.seconds.toFixed(2)} s of audio, best of ${runs} ${best.toFixed(2)} s → ` +
    `${(res.seconds / best).toFixed(1)}x realtime (runs: ${res.times.map((t) => t.toFixed(2)).join(", ")} s)`);
  if (errors.length) {
    console.error(`page errors:\n${errors.join("\n")}`);
    process.exit(1);
  }
})().catch((e) => { console.error(e); process.exit(1); });
