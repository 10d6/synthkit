// Checks the page's plugin mode in headless Chromium, with a stand-in for
// JUCE's web view bridge that records what the page sends and plays the
// plugin's side:
//   node web/test/plugin-ui-test.cjs <synth.html> <out dir>
// The real web view is exercised by the plugin build itself (see CI); this
// covers the message protocol between page and plugin (plugin/Editor.cpp).
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

async function main() {
  const [html, outDir] = process.argv.slice(2);
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const failures = [];
  const fail = (m) => { failures.push(m); console.log("  FAIL  " + m); };
  const pass = (m) => console.log("  PASS  " + m);
  const check = (ok, good, bad) => (ok ? pass(good) : fail(bad));

  const page = await browser.newPage({ viewport: { width: 1240, height: 820 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));

  // What the plugin injects, and a recording stand-in for window.__JUCE__.
  const startPatch = { synth: "sk-basic", name: "From the DAW", params: { "filter.cutoff": 777, "env1.attack": 0.042 } };
  await page.addInitScript((startPatch) => {
    window.__skHost = {
      format: "VST3", host: "Test host",
      state: { patch: startPatch, ui: { current: { kind: "session", name: "From the DAW" }, dirty: true } },
      store: { "synthkit:theme": "light", "synthkit:sk-basic:presets": { "Mine": { synth: "sk-basic", name: "Mine", params: { "filter.cutoff": 1500 } } } },
    };
    const listeners = new Map();
    window.__sent = [];
    window.__JUCE__ = { backend: {
      addEventListener: (id, fn) => { if (!listeners.has(id)) listeners.set(id, []); listeners.get(id).push(fn); },
      emitEvent: (id, payload) => window.__sent.push(JSON.parse(JSON.stringify({ id, ...payload }))),
    } };
    window.__deliver = (msg) => (listeners.get("sk") || []).forEach((fn) => fn(JSON.parse(JSON.stringify(msg))));
  }, startPatch);

  await page.goto("file://" + path.resolve(html));
  await page.waitForFunction(() => window.synthkit && window.synthkit.model, null, { timeout: 15000 });
  await page.waitForTimeout(200);
  const sent = (t) => page.evaluate((t) => window.__sent.filter((m) => !t || m.t === t), t);
  const clear = () => page.evaluate(() => { window.__sent.length = 0; });
  const get = (id) => page.evaluate((id) => window.synthkit.model.get(id), id);

  // 1. Starts from the plugin's sound, without sending it back.
  check(Math.abs((await get("filter.cutoff")) - 777) < 1 && Math.abs((await get("env1.attack")) - 0.042) < 1e-4,
    "page starts from the plugin's sound", `page started with cutoff ${await get("filter.cutoff")}`);
  const presetLabel = await page.evaluate(() => document.querySelector(".preset-select").selectedOptions[0].textContent);
  check(/From the DAW/.test(presetLabel), "preset bar shows the plugin's preset name", `preset bar shows "${presetLabel}"`);
  check((await sent("patch")).length === 0 && (await sent("param")).length === 0, "nothing echoed back on start",
    `sent on start: ${JSON.stringify(await sent())}`);

  // 2. Plugin-only layout.
  const layout = await page.evaluate(() => ({
    banner: document.querySelector(".start-banner").hidden,
    play: !!document.querySelector(".play-btn") && document.querySelector(".play-btn").isConnected,
    midi: !!document.querySelector(".midi") && document.querySelector(".midi").isConnected,
    theme: document.documentElement.dataset.theme,
  }));
  check(layout.banner && !layout.play && !layout.midi, "no start banner, play button or Web MIDI in the plugin",
    `layout: ${JSON.stringify(layout)}`);
  check(layout.theme === "light", "settings come from the plugin's store", `theme ${layout.theme}`);

  // 3. A knob drag is one gesture with values in between.
  await clear();
  await page.evaluate(() => document.querySelector('[data-param="filter.cutoff"]').scrollIntoView({ block: "center" }));
  const dial = await page.locator('[data-param="filter.cutoff"] .knob-dial').boundingBox();
  await page.mouse.move(dial.x + dial.width / 2, dial.y + dial.height / 2);
  await page.mouse.down();
  await page.mouse.move(dial.x + dial.width / 2, dial.y - 40, { steps: 5 });
  await page.mouse.up();
  const drag = await sent();
  const idx = await page.evaluate(() => window.synthkit.model.param("filter.cutoff").index);
  const kinds = drag.map((m) => m.t);
  const ok3 = kinds[0] === "gesture" && drag[0].on === true && drag[0].i === idx && kinds[kinds.length - 1] === "gesture" &&
    drag[drag.length - 1].on === false && drag.filter((m) => m.t === "param" && m.i === idx).length >= 2;
  check(ok3, "knob drag sends gesture start, values, gesture end", `drag sent ${JSON.stringify(kinds)}`);
  const lastV = drag.filter((m) => m.t === "param").pop();
  check(lastV && Math.abs(lastV.v - (await get("filter.cutoff"))) < 1e-3, "sent value matches the page", "sent value differs from the page");

  // 4. Automation from the DAW moves the knob without echoing.
  await clear();
  await page.evaluate((i) => window.__deliver({ t: "params", changes: [[i, 3000]] }), idx);
  const shown = await page.evaluate(() => document.querySelector('[data-param="filter.cutoff"] .ctl-value').textContent);
  check(Math.abs((await get("filter.cutoff")) - 3000) < 1 && /^3(\.00)? kHz$/.test(shown) && (await sent("param")).length === 0,
    "host automation updates the knob and isn't sent back", `after automation: ${await get("filter.cutoff")}, "${shown}", sent ${JSON.stringify(await sent())}`);

  // 5. The DAW loads a project.
  await clear();
  await page.evaluate(() => window.__deliver({ t: "state", patch: { synth: "sk-basic", name: "Pluck", params: { "filter.cutoff": 260 } }, ui: {} }));
  const label5 = await page.evaluate(() => document.querySelector(".preset-select").selectedOptions[0].textContent);
  check(Math.abs((await get("filter.cutoff")) - 260) < 1 && label5 === "Pluck" && (await sent("patch")).length === 0,
    "a project load from the DAW shows its sound (factory name recognised)", `after state: cutoff ${await get("filter.cutoff")}, "${label5}", sent ${JSON.stringify((await sent()).map((m) => m.t))}`);

  // 6. Picking a preset sends the patch and notes the preset for the project.
  await clear();
  await page.selectOption(".preset-select", "user:Mine");
  const p6 = await sent("patch"), m6 = await sent("meta");
  check(p6.length === 1 && JSON.parse(p6[0].json).params["filter.cutoff"] === 1500, "picking a preset sends its patch to the plugin",
    `preset pick sent ${JSON.stringify(p6)}`);
  await page.waitForTimeout(500);   // the session note is debounced
  const meta = (await sent("meta")).pop() || (m6 || []).pop();
  check(meta && meta.ui.current.kind === "user" && meta.ui.current.name === "Mine", "the plugin is told which preset is showing",
    `meta ${JSON.stringify(meta)}`);

  // 7. Saving a preset writes the shared store; another window's save shows up.
  await clear();
  await page.click('button[title="Save preset"]');
  const st = await sent("store");
  check(st.some((m) => m.key === "synthkit:sk-basic:presets" && m.value.Mine), "saving writes presets to the plugin's store",
    `save sent ${JSON.stringify(st.map((m) => m.key))}`);
  await page.evaluate(() => window.__deliver({ t: "store", key: "synthkit:sk-basic:presets", value: {
    Mine: { synth: "sk-basic", name: "Mine", params: {} }, "Other window": { synth: "sk-basic", name: "Other window", params: {} } } }));
  const opts = await page.evaluate(() => [...document.querySelectorAll(".preset-select option")].map((o) => o.textContent));
  check(opts.includes("Other window"), "a preset saved in another plugin window appears", `options ${JSON.stringify(opts)}`);

  // 8. On-screen keyboard plays through the plugin.
  await clear();
  const key = await page.locator(".keys .key").first().boundingBox();
  await page.mouse.click(key.x + key.width / 2, key.y + key.height - 10);
  const midi = await sent("midi");
  check(midi.length >= 2 && (midi[0].d[0] & 0xf0) === 0x90 && (midi[1].d[0] & 0xf0) === 0x80, "on-screen keys send note on/off to the plugin",
    `keys sent ${JSON.stringify(midi)}`);

  // 9. Meters, including NaN-as-null mod values and the DAW's time signature.
  // Layout: sources, then one per parameter (null = not modulated), then (phase, value) per shape.
  const nm = await page.evaluate(() => ({ src: window.synthkit.model.mod.sources.length, par: window.synthkit.model.params.length, shp: window.synthkit.model.mod.shapes }));
  await page.evaluate((nm) => window.__deliver({ t: "meter", voices: 2, limiterDb: 0, peak: 0.5, beat: 1.2, playing: true, bpm: 97.5, num: 3, den: 4,
    scope: Array.from({ length: 1024 }, (_, i) => Math.sin(i / 20) * 0.5),
    mod: [...Array(nm.src).fill(0.25), ...Array.from({ length: nm.par }, (_, i) => (i % 3 ? null : 0.4)), ...Array(nm.shp).fill([0.5, 0.7]).flat()] }), nm);
  await page.waitForTimeout(100);
  const m9 = await page.evaluate(() => ({ voices: document.querySelector(".voice-count").textContent, tempo: document.querySelector(".tempo-readout").textContent,
    beats: document.querySelectorAll(".beats .beat").length }));
  check(m9.voices === "2 voices" && /97\.5 BPM/.test(m9.tempo) && /3\/4/.test(m9.tempo) && m9.beats === 3,
    "meters, tempo and time signature follow the plugin", `meter view ${JSON.stringify(m9)}`);

  // 10. Modulation and shape edits go to the plugin.
  await clear();
  await page.evaluate(() => { const m = window.synthkit.model; const r = m.routes(); r.push({ src: "lfo1", dst: "filter.cutoff", amt: 0.3 }); m.setRoutes(r); });
  await page.evaluate(() => { const m = window.synthkit.model; const s = m.shapes(); s[0].curves[0] = { points: [[0, 0, 0, 0], [1, 1, 0, 0]] }; m.setShapes(s); });
  const mod = await sent("mod"), shp = await sent("shapes");
  check(mod.length === 1 && JSON.parse(mod[0].json).some((r) => r.src === "lfo1") && shp.length === 1,
    "mod matrix and shape edits are sent to the plugin", `sent mod ${mod.length}, shapes ${shp.length}`);

  // 11. Export and import go through the plugin's file dialogs.
  await clear();
  await page.click('button[title="More preset actions"]');
  await page.click('.menu-item:has-text("Export to file")');
  await page.click('button[title="More preset actions"]');
  await page.click('.menu-item:has-text("Import from file")');
  const ex = await sent("export"), im = await sent("import");
  check(ex.length === 1 && JSON.parse(ex[0].json).synth === "sk-basic" && im.length === 1, "export and import ask the plugin for file dialogs",
    `sent ${JSON.stringify((await sent()).map((m) => m.t))}`);
  await clear();
  await page.evaluate(() => window.__deliver({ t: "imported", file: "Bass.json", text: JSON.stringify({ synth: "sk-basic", name: "Imported bass", params: { "filter.cutoff": 400 } }) }));
  const imported = await sent("store"), patch11 = await sent("patch");
  check(Math.abs((await get("filter.cutoff")) - 400) < 1 && imported.some((m) => m.value && m.value["Imported bass"]) && patch11.length === 1,
    "an imported file loads, plays and is saved as a preset", `after import: cutoff ${await get("filter.cutoff")}, sent ${JSON.stringify((await sent()).map((m) => m.t))}`);

  // 12. Logs from the plugin show as toasts.
  await page.evaluate(() => window.__deliver({ t: "log", msg: "Saved Bass.json", kind: "info" }));
  check(await page.evaluate(() => [...document.querySelectorAll(".toast")].some((t) => t.textContent === "Saved Bass.json")),
    "messages from the plugin show as toasts", "plugin message didn't show");

  await page.screenshot({ path: path.join(outDir, "ui-plugin.png") });
  check(errors.length === 0, "no console errors in plugin mode", `console errors: ${errors.join(" | ")}`);
  await browser.close();
  if (failures.length) { console.log(`FAILED: ${failures.length}`); process.exit(1); }
  console.log("OK");
}

main().catch((e) => { console.error(e); process.exit(1); });
