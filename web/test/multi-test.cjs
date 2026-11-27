// Headless-Chromium checks for the sound bar and the multi bar (API.md §5b)
// on a synth with features.multi:
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
  check(await ev(() => window.synthkit.app.sound.factoryMultis.length) === 3, "factory multis are embedded in the page");
  check(await page.locator("header .sound .sound-select").isVisible() && !(await page.locator(".multi").isVisible()),
    "the top bar picks sounds; the multi drawer is closed with one part");
  const groups = await ev(() => [...document.querySelectorAll(".sound-select optgroup")].map((g) => g.label));
  check(groups.includes("Multis") && groups.includes("Pads"), "the sound list has the preset categories and a Multis category", groups);

  // Picking a multi from the top bar loads the whole sound; picking a preset
  // goes back to one part playing it.
  await page.selectOption(".sound-select", "m:factory:multis/bass-and-pad.json");
  let snd = await ev(() => ({ parts: window.synthkit.model.layout().parts.length, tag: !document.querySelector(".sound-tag").hidden,
    btn: document.querySelector(".sound-multi").textContent, tabs: document.querySelector(".multi").hidden }));
  check(snd.parts === 2 && snd.tag && snd.btn.startsWith("Layers and splits") && !snd.tabs, "a multi from the top bar: two parts, tagged, part tabs showing", snd);
  const warm = await ev(() => { const e = window.synthkit.app.sound.entries().find((x) => x.type === "patch" && x.category === "Pads"); return window.synthkit.app.sound.value(e); });
  await page.selectOption(".sound-select", warm);
  snd = await ev(() => ({ parts: window.synthkit.model.layout().parts.length, plain: window.synthkit.app.sound.plain(), tag: !document.querySelector(".sound-tag").hidden,
    shown: document.querySelector(".sound-select").value, hidden: document.querySelector(".multi").hidden, btn: document.querySelector(".sound-multi").textContent }));
  check(snd.parts === 1 && snd.plain && !snd.tag && snd.shown === warm && snd.hidden && snd.btn.startsWith("Layers and splits"),
    "a preset from the top bar: one part across the keyboard, no multi editing in sight", snd);
  await ev(() => window.synthkit.model.history.undo());
  check(await ev(() => window.synthkit.model.layout().parts.length) === 2, "loading a sound can be undone");
  await page.selectOption(".sound-select", warm);

  // Open the drawer: the part's patch picker is in it.
  await page.click(".sound-multi");
  check(await page.locator(".multi .mix-patch .preset-select").isVisible() && await page.locator(".zmap").isVisible(),
    "Layers and splits opens the drawer: the part's patch picker and the zones");

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

  // ---- remove the selected part ----------------------------------------------------------------
  await page.click(".part-add");                                                   // a third part
  await ev(() => window.synthkit.model.set("filter.cutoff", 3210));
  check(await page.locator(".part .part-remove").count() === 3, "each part's tab has a remove button");
  await page.click('.part-remove[title="Remove part 2"]');                          // part 3 (selected) stays selected
  lay = await ev(() => window.synthkit.model.layout());
  const moved = await ev(() => ({ part: window.synthkit.model.part, cutoff: window.synthkit.model.get("filter.cutoff") }));
  check(lay.parts.length === 2 && lay.zones.every((z) => z.part < 2) && moved.part === 1 && Math.abs(moved.cutoff - 3210) < 20,
    "× on part 2 removes it with no selecting first; part 3 moves down with its sound and zone, still selected", { parts: lay.parts.length, moved });
  await ev(() => window.synthkit.model.history.undo());
  check(await ev(() => window.synthkit.model.layout().parts.length) === 3, "removing a part can be undone");
  await ev(() => window.synthkit.model.history.redo());
  await ev(() => window.synthkit.app.multiBar.setOpen(false));
  check(await page.locator(".part .part-remove").count() === 0, "with the drawer closed the tabs have no remove buttons");
  await ev(() => window.synthkit.app.multiBar.setOpen(true));

  // ---- a part in a scale -----------------------------------------------------------------------------
  // (The part's patch's own sk.scale and sk.scaleKey.)
  const scaleSel = '.multi-mix [data-param="sk.scale"] select', keySel = '.multi-mix [data-param="sk.scaleKey"] select';
  check(await ev((q) => document.querySelector(q).selectedOptions[0].textContent === "Chromatic", scaleSel), "parts start chromatic");
  const penta = await ev((q) => [...document.querySelector(q).options].find((o) => o.textContent === "Major Pentatonic").value, scaleSel);
  await page.selectOption(scaleSel, penta);
  await page.selectOption(keySel, "2");
  check(await ev(() => window.synthkit.model.format("sk.scale") === "Major Pentatonic" && Math.round(window.synthkit.model.get("sk.scaleKey")) === 2),
    "a scale and key for the selected part's patch", await ev(() => window.synthkit.model.format("sk.scale")));
  const snapped = await ev(async () => {
    const sk = window.synthkit;
    const patch = sk.model.savePatch();
    patch.params["sk.scale"] = 0;                               // (the part's own scale, set above, out of the way)
    const one = (scale) => ({ format: "sk.multi", version: 1, synth: sk.model.info.synth.id, parts: [{ patch, ...(scale ? { scale, scaleKey: 0 } : {}) }] });
    const play = async (multi, note) => (await sk.renderOffline({ multi: JSON.stringify(multi), seconds: 0.6, events: [{ t: 0, d: [0x90, note, 100] }, { t: 0.4, d: [0x80, note, 64] }] })).left;
    const a = await play(one("Major"), 61), b = await play(one(null), 60), c = await play(one(null), 61);
    let dab = 0, dac = 0, e = 0;
    for (let i = 0; i < a.length; i++) { dab = Math.max(dab, Math.abs(a[i] - b[i])); dac = Math.max(dac, Math.abs(a[i] - c[i])); e = Math.max(e, Math.abs(b[i])); }
    return { dab, dac, e };
  });
  check(snapped.e > 0.01 && snapped.dab < 1e-6 && snapped.dac > 1e-3, "in C major, C♯ plays C (rendered in the worklet; an older multi's part scale moves into its patch)", snapped);

  // ---- saving ----------------------------------------------------------------------------------
  await ev(() => window.synthkit.app.sound.storeAs("My split"));
  check(await ev(() => Object.keys(window.synthkit.app.sound.userMultis).includes("My split") && document.querySelector(".sound .preset-dirty").hidden),
    "Save keeps a multi as one of yours, unchanged since", await ev(() => Object.keys(window.synthkit.app.sound.userMultis)));
  check(await ev(() => [...document.querySelectorAll(".sound-select optgroup")].some((g) => g.label === "Multis · yours")), "your multis are listed under Multis");
  await ev(() => window.synthkit.model.set("filter.cutoff", 999));
  await page.waitForTimeout(100);
  check(await page.locator(".sound .preset-dirty").isVisible(), "an edit marks the sound changed");
  await page.selectOption(".sound-select", warm);
  await ev(() => window.synthkit.model.set("filter.cutoff", 1500));
  await ev(() => window.synthkit.app.sound.storeAs("My pad"));
  check(await ev(() => !!window.synthkit.app.presets.user["My pad"] && !window.synthkit.app.sound.userMultis["My pad"]), "one plain part saves as a preset");
  await page.selectOption(".sound-select", "m:user:My split");
  check(await ev(() => window.synthkit.model.layout().parts.length) === 2 && await ev(() => window.synthkit.app.sound.shown().name) === "My split", "a saved multi loads back");

  // ---- the session ------------------------------------------------------------------------------
  await ev(() => window.synthkit.model.selectPart(1));
  await page.waitForTimeout(600);
  await boot();
  check(await ev(() => window.synthkit.model.layout().parts.length) === 2 && await ev(() => window.synthkit.model.part) === 1 &&
    await ev(() => window.synthkit.app.sound.shown().name) === "My split" && await page.locator(".sound .preset-dirty").isHidden(),
    "the multi, its name and the selected part come back after a reload");
  await page.screenshot({ path: path.join(outDir, "multi-sound.png"), fullPage: true });

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
