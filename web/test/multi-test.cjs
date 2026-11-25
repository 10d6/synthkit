// Headless-Chromium checks for the multi bar (API.md §5b) on a synth with
// features.multi:
//   node web/test/multi-test.cjs <synth.html> <out dir> [multi scenario.json]
// Parts and their independent state, the zone editor (fields, dragging,
// keyboard), undo, saved multis, the session, edits reaching the audio
// thread tagged with their part, and a split rendered through the real
// AudioWorklet.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

async function main() {
  const [html, outDir, scenarioPath] = process.argv.slice(2);
  fs.mkdirSync(outDir, { recursive: true });
  const url = "file://" + path.resolve(html);
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const failures = [];
  const fail = (m) => { failures.push(m); console.log("  FAIL  " + m); };
  const pass = (m) => console.log("  PASS  " + m);
  const check = (ok, m, detail) => (ok ? pass(m) : fail(m + (detail !== undefined ? ` (${JSON.stringify(detail)})` : "")));

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  const boot = async () => {
    await page.goto(url);
    await page.waitForFunction(() => window.synthkit && window.synthkit.model, null, { timeout: 15000 });
    await page.waitForTimeout(200);
  };
  const ev = (fn, arg) => page.evaluate(fn, arg);
  await boot();
  await ev(() => localStorage.clear());
  await boot();

  // ---- the bar ------------------------------------------------------------------------
  check(await ev(() => window.synthkit.model.multi === true), "the synth is a multi (features.multi)");
  check(await page.locator(".multi .part-tab").count() === 1, "starts as one part");
  check(await ev(() => window.synthkit.app.multiBar.factory.length) === 3, "factory multis are embedded in the page");

  // Add a part: it's selected, layered over the keyboard, and has its own sound.
  await page.click(".part-add");
  let lay = await ev(() => window.synthkit.model.layout());
  check(lay.parts.length === 2 && lay.zones.length === 2 && lay.zones[1].part === 1, "+ Part adds a part with a zone over every key", lay);
  check(await ev(() => window.synthkit.model.part) === 1, "the new part is selected");
  await ev(() => window.synthkit.model.set("filter.cutoff", 1234));
  const cut2 = await ev(() => window.synthkit.model.get("filter.cutoff"));
  await page.click(".part:nth-child(1) .part-tab");
  const cut1 = await ev(() => window.synthkit.model.get("filter.cutoff"));
  check(cut1 !== cut2 && Math.abs(cut2 - 1234) < 20, "each part keeps its own parameters", { cut1, cut2 });
  await page.click(".part:nth-child(2) .part-tab");
  check(Math.abs((await ev(() => window.synthkit.model.get("filter.cutoff"))) - 1234) < 20, "selecting a part again shows its own values");
  // Arrow keys move between part tabs.
  await page.focus('.part-tab[aria-selected="true"]');
  await page.keyboard.press("ArrowLeft");
  check(await ev(() => window.synthkit.model.part) === 0, "Left arrow selects the previous part");

  // ---- undo follows the part -----------------------------------------------------------
  await page.click(".part:nth-child(2) .part-tab");
  await ev(() => window.synthkit.model.set("filter.resonance", 0.9));
  await page.click(".part:nth-child(1) .part-tab");
  await ev(() => window.synthkit.model.history.undo());
  check(await ev(() => window.synthkit.model.part) === 1 && (await ev(() => window.synthkit.model.get("filter.resonance"))) !== 0.9,
    "undo goes back to the part a change was made in");

  // ---- zone editor -----------------------------------------------------------------------
  await page.click(".zones-btn");
  check(await page.locator(".zrect").count() === 2, "the zone map shows both zones");
  await page.screenshot({ path: path.join(outDir, "multi-zones.png"), fullPage: true });

  await page.click(".zchip:nth-child(1)");
  await page.fill('.zform [aria-label="Highest key"]', "59");
  await page.keyboard.press("Tab");
  lay = await ev(() => window.synthkit.model.layout());
  check(lay.zones[0].key[1] === 59, "typing a highest key sets the zone", lay.zones[0]);
  await page.click(".zchip:nth-child(2)");
  await page.fill('.zform [aria-label="Lowest key"]', "57");
  await page.fill('.zform [aria-label="Key fade in"]', "3");
  await page.keyboard.press("Tab");
  lay = await ev(() => window.synthkit.model.layout());
  check(lay.zones[1].key[0] === 57 && lay.zones[1].keyFade && lay.zones[1].keyFade[0] === 3, "a lowest key and a fade", lay.zones[1]);

  // Drag zone 1's body: it moves along the keys.
  const box = await page.locator('.zrect[data-zone="0"]').boundingBox();
  const before = (await ev(() => window.synthkit.model.layout())).zones[0].key.slice();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  const after = (await ev(() => window.synthkit.model.layout())).zones[0].key;
  check(after[0] > before[0] && after[1] - after[0] === before[1] - before[0], "dragging a zone moves it and keeps its width", { before, after });
  await ev(() => window.synthkit.model.history.undo());
  check(JSON.stringify((await ev(() => window.synthkit.model.layout())).zones[0].key) === JSON.stringify(before), "a whole drag is one undo step");

  // Drag its right edge: it resizes.
  const b2 = await page.locator('.zrect[data-zone="0"]').boundingBox();
  await page.mouse.move(b2.x + b2.width - 2, b2.y + b2.height / 2);
  await page.mouse.down();
  await page.mouse.move(b2.x + b2.width - 40, b2.y + b2.height / 2, { steps: 5 });
  await page.mouse.up();
  const resized = (await ev(() => window.synthkit.model.layout())).zones[0].key;
  check(resized[0] === before[0] && resized[1] < before[1], "dragging an edge resizes", { before, resized });

  // Keyboard: arrows nudge the focused zone.
  await page.focus('.zrect[data-zone="0"]');
  const k0 = (await ev(() => window.synthkit.model.layout())).zones[0].key.slice();
  await page.keyboard.press("ArrowRight");
  const k1 = (await ev(() => window.synthkit.model.layout())).zones[0].key;
  check(k1[0] === k0[0] + 1 && k1[1] === k0[1] + 1, "Right arrow nudges a zone by a key", { k0, k1 });

  // Quick setups.
  await page.click(".zones-bar .btn-quiet:has-text('Set up')");
  await page.click(".menu-item:has-text('Velocity layers')");
  lay = await ev(() => window.synthkit.model.layout());
  check(lay.zones.length === 2 && lay.zones[0].velFade && lay.zones[0].velFade[1] > 0 && lay.zones[1].velFade[0] > 0, "Set up → velocity layers crossfades two parts", lay.zones);
  await ev(() => window.synthkit.model.history.undo());
  check((await ev(() => window.synthkit.model.layout())).zones[0].velFade === undefined, "a set-up is one undo step");

  // Mix.
  await page.click(".part:nth-child(1) .part-flag:has-text('M')");
  check((await ev(() => window.synthkit.model.layout())).parts[0].mute === true, "M mutes a part");
  await page.click(".part:nth-child(1) .part-flag:has-text('M')");

  // ---- edits reach the audio thread tagged with their part ----------------------------------
  await page.mouse.click(5, 5);
  await page.waitForFunction(() => window.synthkit.app.audio.running, null, { timeout: 10000 });
  await ev(() => {
    const a = window.synthkit.app.audio, orig = a.send.bind(a);
    window.__sent = [];
    a.send = (m) => { window.__sent.push(m); orig(m); };
  });
  await page.click(".part:nth-child(1) .part-tab");
  await page.click(".part:nth-child(2) .part-tab");
  await ev(() => window.synthkit.model.set("filter.cutoff", 777));
  await ev(() => window.synthkit.model.setLayout({ ...window.synthkit.model.layout() }));
  const sent = await ev(() => window.__sent);
  check(sent.some((m) => m.t === "select" && m.p === 1), "selecting a part tells the audio thread");
  check(sent.some((m) => m.t === "param" && m.p === 1), "a parameter edit says which part it is for", sent);
  check(sent.some((m) => m.t === "layout"), "a layout edit is sent to the audio thread");
  await page.mouse.click(5, 5);

  // ---- saved multis ----------------------------------------------------------------------------
  await ev(() => { const b = window.synthkit.app.multiBar; b.nameInput.value = "My split"; b.nameInput.dispatchEvent(new Event("change")); b.saveMulti(); });
  check(await ev(() => Object.keys(window.synthkit.app.multiBar.user).includes("My split")), "Save keeps the multi in this browser");
  await ev(() => window.synthkit.app.multiBar.single());
  check(await ev(() => window.synthkit.model.layout().parts.length) === 1, "One part, keeping the sound being edited");
  await ev(() => window.synthkit.app.multiBar.load(window.synthkit.app.multiBar.user["My split"]));
  lay = await ev(() => window.synthkit.model.layout());
  check(lay.parts.length === 2, "a saved multi loads back", lay.parts);
  await page.click(".multi-lib .btn:has-text('Multi')");
  await page.click(".menu-item:has-text('Bass and pad')");
  lay = await ev(() => window.synthkit.model.layout());
  const names = await ev(() => window.synthkit.model.partNames().slice(0, 2).map((p) => p.name));
  check(lay.parts.length === 2 && lay.zones.length === 2 && names[0] !== names[1], "a factory multi loads both parts' sounds", { names });
  await ev(() => window.synthkit.model.history.undo());
  check(await ev(() => window.synthkit.model.layout().parts.length) === 2 && await ev(() => window.synthkit.model.partNames()[0].name) !== names[0],
    "loading a multi can be undone");

  // ---- the session ------------------------------------------------------------------------------
  await ev(() => window.synthkit.app.multiBar.load(window.synthkit.app.multiBar.factory[0].multi));
  await ev(() => window.synthkit.model.selectPart(1));
  await page.waitForTimeout(600);
  await boot();
  check(await ev(() => window.synthkit.model.layout().parts.length) === 2 && await ev(() => window.synthkit.model.part) === 1,
    "the multi and the selected part come back after a reload");

  // ---- a split, rendered through the AudioWorklet --------------------------------------------------
  const levels = await ev(async () => {
    const sk = window.synthkit;
    const multi = sk.model.multiSave();
    // Part 1 plays the keys below 60 at full level, part 2 the keys from 60 up, 50 dB down.
    multi.parts = multi.parts.slice(0, 2);
    multi.parts[0].level = 0; multi.parts[1].level = -50;
    multi.parts[0].mute = multi.parts[1].mute = false; delete multi.parts[0].solo; delete multi.parts[1].solo;
    multi.zones = [{ part: 0, key: [0, 59] }, { part: 1, key: [60, 127] }];
    const rms = (a) => { let s = 0; for (const v of a) s += v * v; return Math.sqrt(s / a.length); };
    const out = {};
    for (const note of [48, 72]) {
      const r = await sk.renderOffline({ multi: JSON.stringify(multi), seconds: 1, events: [{ t: 0, d: [0x90, note, 100] }, { t: 0.8, d: [0x80, note, 64] }] });
      out[note] = rms(r.left.subarray(9600, 36000));
    }
    return out;
  });
  check(levels[48] > 0.01 && levels[48] / Math.max(levels[72], 1e-9) > 100, "a split rendered in the worklet: the low key is loud, the high key (part 2, −50 dB) is quiet", levels);

  // A multi scenario (the render tool's format) through the worklet, written
  // for comparison with the native renderer.
  if (scenarioPath) {
    const sc = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
    const out = await ev(async (sc) => {
      const sk = window.synthkit;
      const entry = sk.model.info.multis.find((m) => m.path.endsWith("/" + sc.multi + ".json"));
      const events = sc.events.map((e) => ({ t: e.t, d: e.on !== undefined ? [0x90 | (e.ch || 0), e.on, e.vel ?? 100] : [0x80 | (e.ch || 0), e.off, 64] }));
      const r = await sk.renderOffline({ multi: JSON.stringify(entry.multi), events, seconds: sc.length, sampleRate: 48000, transport: { bpm: 120, playing: false, num: 4, den: 4 } });
      return { left: Array.from(r.left), right: Array.from(r.right) };
    }, sc);
    const n = out.left.length, buf = Buffer.alloc(n * 8);
    for (let i = 0; i < n; i++) { buf.writeFloatLE(out.left[i], i * 8); buf.writeFloatLE(out.right[i], i * 8 + 4); }
    fs.writeFileSync(path.join(outDir, "web-render.f32"), buf);
    pass(`multi scenario rendered through the worklet: ${(n / 48000).toFixed(2)} s`);
  }

  check(errors.length === 0, "no console errors", errors);
  await browser.close();
  console.log(failures.length ? `FAILED: ${failures.length}` : "OK");
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
