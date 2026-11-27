// Headless-Chromium checks for the sound bar and the rack (API.md §5b, §9)
// on a synth with features.multi:
//   node web/test/multi-test.cjs <synth.html> <out dir> [multi scenario.json]
// Voices (strips, opening, adding, removing, renaming) and their independent
// state, the zone editor (fields, dragging,
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

  // ---- the rack ------------------------------------------------------------------------
  const rackState = () => ev(() => ({
    voices: document.querySelectorAll(".rack .voice").length,
    open: [...document.querySelectorAll(".rack .voice")].map((v) => v.classList.contains("is-open")),
    layers: !document.querySelector("#sk-multi").hidden,
    flags: !document.querySelector(".voice-flags").hidden,
    remove: !document.querySelector(".voice-remove").hidden,
    part: window.synthkit.model.part,
  }));
  check(await ev(() => window.synthkit.model.multi === true), "the synth is a multi (features.multi)");
  let rs = await rackState();
  check(rs.voices === 1 && rs.open[0] && !rs.layers && !rs.flags && !rs.remove && await page.locator(".add-voice").isVisible(),
    "one voice: open, no Layers and splits, mute/solo or ×; Add voice below it", rs);
  check(await ev(() => window.synthkit.app.sound.factoryMultis.length) === 3, "factory multis are embedded in the page");
  // The strip, left to right.
  const order = await ev(() => {
    const strip = document.querySelector(".voice-strip");
    const at = (sel) => { const el = strip.querySelector(sel); return el ? [...strip.querySelectorAll("*")].indexOf(el) : -1; };
    return [".voice-toggle", ".voice-name", ".voice-edit", ".voice-flags", '[data-param="master"]', '[data-param="sk.pan"]', ".voice-num", ".voice-scale", '[data-param="sk.a4"]', ".voice-remove"].map(at);
  });
  check(order.every((x, i) => x >= 0 && (i === 0 || x > order[i - 1])), "the strip: Show more, name, rename, M/S, Volume, Pan, Transpose, Scale, Tune, ×", order);
  check(await ev(() => document.querySelector(".voice-toggle").textContent === "Compact view" && document.querySelector(".voice-strip .voice-name").textContent === "Init"),
    "an open voice's toggle says Compact view; the strip shows the voice's name");
  check(await ev(() => document.querySelector('.voice-strip [data-param="sk.a4"] .ctl-value').textContent === "0 ct"), "Tune reads in cents");
  check(await ev(() => !document.querySelector(".panel-toggle") || ![...document.querySelectorAll(".panel-title")].some((t) => t.textContent.trim() === "Output")),
    "the Output panel's place is taken by the strip");
  const groups = await ev(() => [...document.querySelectorAll(".sound-select optgroup")].map((g) => g.label));
  check(groups.includes("Multis") && groups.includes("Pads"), "the sound list has the preset categories and a Multis category", groups);

  // Picking a multi from the top bar loads the whole sound, its voices closed;
  // picking a preset goes back to one voice playing it, open.
  await page.selectOption(".sound-select", "m:factory:multis/bass-and-pad.json");
  rs = await rackState();
  check(rs.voices === 2 && rs.open.every((o) => !o) && rs.layers && rs.flags && rs.remove && await ev(() => !document.querySelector(".sound-tag").hidden),
    "a multi from the top bar: two voices, closed, with Layers and splits, M/S and ×", rs);
  const warm = await ev(() => { const e = window.synthkit.app.sound.entries().find((x) => x.type === "patch" && x.category === "Pads"); return window.synthkit.app.sound.value(e); });
  await page.selectOption(".sound-select", warm);
  rs = await rackState();
  check(rs.voices === 1 && rs.open[0] && !rs.layers && await ev(() => window.synthkit.app.sound.plain()), "a preset from the top bar: one voice, open", rs);
  await ev(() => window.synthkit.model.history.undo());
  check(await ev(() => window.synthkit.model.layout().parts.length) === 2, "loading a sound can be undone");
  await page.selectOption(".sound-select", warm);

  // ---- Add voice ------------------------------------------------------------------------------
  const addOpt = (name) => ev((name) => [...document.querySelector(".add-voice-select").options].find((o) => o.textContent === name).value, name);
  await page.selectOption(".add-voice-select", await addOpt("Mono Bass"));
  let lay = await ev(() => window.synthkit.model.layout());
  rs = await rackState();
  check(lay.parts.length === 2 && lay.zones.length === 2 && lay.zones[1].part === 1 && JSON.stringify(lay.zones[1].key) === "[0,127]",
    "Add voice adds a voice layered over every key", lay);
  check(rs.open[0] && !rs.open[1] && rs.part === 0 && rs.layers && await ev(() => document.querySelector(".layers .zmap").offsetParent !== null),
    "the voice being edited stays open, the new one is closed; Layers and splits shows, open", rs);
  check(await ev(() => document.querySelectorAll(".voice-strip .voice-name")[1].textContent) === "Mono Bass" &&
    await ev(() => window.synthkit.model.getIn(1, "master")) === await ev(() => window.synthkit.app.presets.entries().find((e) => e.name === "Mono Bass").patch.params.master ?? 0),
    "the new voice is the preset, its own volume and all");
  check(await ev(() => !document.querySelector(".voice .preset-select") && document.querySelectorAll(".voice-save-copy:not([hidden])").length === 2),
    "in a multi, a voice has no preset picker of its own, and each strip has Save as new voice");

  // Layers and splits selects a zone at first: the last voice added (nothing edited yet).
  const selPart = () => ev(() => { const l = window.synthkit.model.layout(), i = window.synthkit.app.rack.layers.sel; return i >= 0 ? l.zones[i].part : -1; });
  check(await selPart() === 1, "Layers and splits selects the zone of the voice just added", await selPart());
  check(await ev(() => document.querySelector('.zform .zf:has([aria-label="Zone transpose"])').hidden), "a zone without a transpose doesn't show one (each voice has its own)");
  await ev(() => { const m = window.synthkit.model, l = m.layout(); l.zones[1].transpose = 5; m.setLayout(l); });
  check(await ev(() => !document.querySelector('.zform .zf:has([aria-label="Zone transpose"])').hidden), "…but one that has a transpose (an older multi) shows it, to clear");
  await ev(() => window.synthkit.model.history.undo());
  // Once a voice is edited, it's the one: add a third voice and voice 1's zone is selected.
  await ev(() => window.synthkit.model.setIn(0, "sk.pan", 0.3, "ui"));
  await page.selectOption(".add-voice-select", await addOpt("Init"));
  check(await selPart() === 0, "…after an edit, the zone of the voice last edited (voice 1), not the one added", await selPart());
  await ev(() => window.synthkit.model.history.undo());
  await ev(() => window.synthkit.model.history.undo());

  // Save as new voice: a copy in your presets under a name not taken (a number after it);
  // the voice itself and the multi don't change.
  const sig0 = await ev(() => window.synthkit.app.sound.sig());
  await page.click(".voice:nth-child(2) .voice-save-copy");
  await page.waitForSelector(".sk-dialog");
  check(await ev(() => document.querySelector(".sk-dialog .sk-field").value) === "Mono Bass 2", "the copy's name: the voice's, with a number as a factory preset has it");
  await page.keyboard.press("Enter");
  check(await ev(() => { const u = window.synthkit.app.presets.user["Mono Bass 2"]; return !!u && u.params && window.synthkit.model.nameOf(1) === "Mono Bass"; }),
    "Save copy keeps it as one of your presets; the voice keeps its name");
  check(await ev(() => window.synthkit.app.sound.sig()) === sig0, "saving a copy doesn't change the multi");
  await page.click(".voice:nth-child(2) .voice-save-copy");
  await page.waitForSelector(".sk-dialog");
  await page.fill(".sk-dialog .sk-field", "Mono Bass 2");
  check(await page.locator(".sk-dialog .sk-hint").isVisible(), "typing a taken name says what it will be saved as");
  await page.click(".sk-dialog button[data-value=ok]");
  check(await ev(() => !!window.synthkit.app.presets.user["Mono Bass 3"]), "a taken name gets the next number (Mono Bass 3), never replacing one");
  await page.click(".voice:nth-child(2) .voice-save-copy");
  await page.waitForSelector(".sk-dialog");
  await page.keyboard.press("Escape");
  check(await ev(() => !document.querySelector(".sk-dialog") && Object.keys(window.synthkit.app.presets.user).length === 2), "Escape cancels");
  await ev(() => window.synthkit.model.history.undo());
  check((await rackState()).voices === 1, "adding a voice is one undo step");
  await ev(() => window.synthkit.model.history.redo());

  // ---- opening voices ---------------------------------------------------------------------------
  await page.click(".voice:nth-child(2) .voice-toggle");
  rs = await rackState();
  check(!rs.open[0] && rs.open[1] && rs.part === 1 && await ev(() => !!document.querySelector(".voice:nth-child(2) .voice-panels .panels")),
    "Show more opens a voice (selecting it) with the synth's panels; the other closes", rs);
  await ev(() => window.synthkit.model.set("filter.cutoff", 1234));
  const cut2 = await ev(() => window.synthkit.model.get("filter.cutoff"));
  await page.click(".voice:nth-child(1) .voice-toggle");
  const cut1 = await ev(() => window.synthkit.model.get("filter.cutoff"));
  check(cut1 !== cut2 && Math.abs(cut2 - 1234) < 20, "each voice keeps its own parameters", { cut1, cut2 });
  await page.click(".voice:nth-child(1) .voice-toggle");
  rs = await rackState();
  check(rs.open.every((o) => !o) && await ev(() => document.querySelector(".voice-toggle").textContent === "Show more"), "Compact view closes it again", rs);
  await page.click(".voice:nth-child(1) .voice-toggle");

  // A closed voice's strip edits that voice, without opening or selecting it.
  await page.fill(".voice:nth-child(2) .voice-num", "-12");
  await page.keyboard.press("Tab");
  rs = await rackState();
  check(await ev(() => window.synthkit.model.getIn(1, "sk.transpose")) === -12 && await ev(() => window.synthkit.model.get("sk.transpose")) === 0 && rs.part === 0 && rs.open[0],
    "a closed voice's Transpose sets that voice's patch; the open voice stays open", rs);
  await page.focus('.voice:nth-child(2) [data-param="master"] .knob-dial');
  await page.keyboard.press("ArrowDown");
  check(await ev(() => window.synthkit.model.getIn(1, "master")) < await ev(() => window.synthkit.app.presets.entries().find((e) => e.name === "Mono Bass").patch.params.master ?? 0),
    "its Volume knob turns that voice down");
  await ev(() => window.synthkit.model.history.undo());
  await ev(() => window.synthkit.model.history.undo());
  rs = await rackState();
  check(await ev(() => window.synthkit.model.getIn(1, "sk.transpose")) === 0 && rs.part === 0 && rs.open[0], "undoing a strip edit doesn't move the open voice", rs);

  // Renaming: the pencil, then ✓ (or Enter), ✗ (or Escape).
  await page.click(".voice:nth-child(2) .voice-edit");
  check(await page.locator(".voice:nth-child(2) .voice-name-input").isVisible() && await page.locator(".voice:nth-child(2) .voice-ok").isVisible() &&
    await page.locator(".voice:nth-child(2) .voice-cancel").isVisible(), "the pencil turns the name into a field with ✓ and ✗");
  await page.fill(".voice:nth-child(2) .voice-name-input", "Low end");
  await page.click(".voice:nth-child(2) .voice-ok");
  check(await ev(() => window.synthkit.model.nameOf(1)) === "Low end" && await ev(() => document.querySelectorAll(".voice-name")[1].textContent) === "Low end",
    "✓ renames the voice's patch");
  await page.click(".voice:nth-child(2) .voice-edit");
  await page.fill(".voice:nth-child(2) .voice-name-input", "Nope");
  await page.keyboard.press("Escape");
  check(await ev(() => window.synthkit.model.nameOf(1)) === "Low end", "Escape cancels");
  await ev(() => window.synthkit.model.history.undo());
  check(await ev(() => window.synthkit.model.nameOf(1)) === "Mono Bass", "renaming can be undone");
  await ev(() => window.synthkit.model.history.redo());

  // Layers and splits: open or closed is saved with the multi, and isn't an undo step.
  const undoLabel = await ev(() => window.synthkit.model.history.undoLabel);
  await page.click("#sk-multi .panel-toggle");
  check(await ev(() => window.synthkit.model.multiSave().ui.layersOpen === false && document.querySelector(".layers-body").hidden) &&
    await ev(() => window.synthkit.model.history.undoLabel) === undoLabel, "closing Layers and splits is saved in the multi, not an undo step");
  await page.click("#sk-multi .panel-toggle");

  // ---- undo follows the part -----------------------------------------------------------
  await page.click(".voice:nth-child(2) .voice-toggle");
  await ev(() => window.synthkit.model.set("filter.reso", 0.9));
  await page.click(".voice:nth-child(1) .voice-toggle");
  await ev(() => window.synthkit.model.history.undo());
  rs = await rackState();
  check(rs.part === 1 && rs.open[1] && (await ev(() => window.synthkit.model.get("filter.reso"))) !== 0.9,
    "undo goes back to (and opens) the voice a change was made in", rs);

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

  // Mute.
  await page.click(".voice:nth-child(1) .voice-flag:has-text('M')");
  check((await ev(() => window.synthkit.model.layout())).parts[0].mute === true && await ev(() => document.querySelector(".voice").classList.contains("is-muted")), "M mutes a voice");
  await page.click(".voice:nth-child(1) .voice-flag:has-text('M')");

  // ---- edits reach the audio thread tagged with their part ----------------------------------
  await page.mouse.click(5, 5);
  await page.waitForFunction(() => window.synthkit.app.audio.running, null, { timeout: 10000 });
  await ev(() => {
    const a = window.synthkit.app.audio, orig = a.send.bind(a);
    window.__sent = [];
    a.send = (m) => { window.__sent.push(m); orig(m); };
  });
  await page.click(".voice:nth-child(1) .voice-toggle");
  await page.click(".voice:nth-child(2) .voice-toggle");
  await ev(() => window.synthkit.model.set("filter.cutoff", 777));
  await ev(() => window.synthkit.model.setLayout({ ...window.synthkit.model.layout() }));
  await page.fill(".voice:nth-child(1) .voice-num", "5");
  await page.keyboard.press("Tab");
  const sent = await ev(() => window.__sent);
  check(sent.some((m) => m.t === "select" && m.p === 1), "opening a voice tells the audio thread");
  check(sent.some((m) => m.t === "param" && m.p === 1), "a parameter edit says which part it is for", sent);
  check(sent.some((m) => m.t === "param" && m.p === 0), "a closed voice's strip edit goes to its own part", sent);
  check(sent.some((m) => m.t === "layout"), "a layout edit is sent to the audio thread");
  await ev(() => window.synthkit.model.setIn(0, "sk.transpose", 0));
  await page.mouse.click(5, 5);

  // ---- removing voices -------------------------------------------------------------------------
  await page.selectOption(".add-voice-select", await addOpt("Warm Pad"));             // a third voice
  await page.click(".voice:nth-child(3) .voice-toggle");
  await ev(() => window.synthkit.model.set("filter.cutoff", 3210));
  check(await page.locator(".voice .voice-remove:visible").count() === 3, "each voice has ×");
  await page.click('.voice-remove[aria-label="Remove voice 2"]');                       // voice 3 (open) moves up, still open
  lay = await ev(() => window.synthkit.model.layout());
  const moved = await ev(() => ({ part: window.synthkit.model.part, cutoff: window.synthkit.model.get("filter.cutoff") }));
  rs = await rackState();
  check(lay.parts.length === 2 && lay.zones.every((z) => z.part < 2) && moved.part === 1 && Math.abs(moved.cutoff - 3210) < 20 && rs.open[1],
    "× on voice 2 removes it; voice 3 moves up with its sound and zone, still open", { parts: lay.parts.length, moved, rs });
  await ev(() => window.synthkit.model.history.undo());
  check(await ev(() => window.synthkit.model.layout().parts.length) === 3, "removing a voice can be undone");
  await ev(() => window.synthkit.model.history.redo());
  // Down to one voice: with its zone still a split it's still a multi;
  // across the keyboard, it's a single voice again, open.
  await page.click('.voice-remove[aria-label="Remove voice 2"]');
  rs = await rackState();
  check(rs.voices === 1 && rs.layers && rs.flags, "one voice left on part of the keyboard: Layers and splits stays, so no key goes silent unseen", rs);
  await ev(() => window.synthkit.model.history.undo());
  await ev(() => { const m = window.synthkit.model, l = m.layout(); l.zones = l.parts.map((_, p) => ({ part: p, key: [0, 127], vel: [1, 127] })); m.setLayout(l); });
  await page.click('.voice-remove[aria-label="Remove voice 2"]');
  rs = await rackState();
  check(rs.voices === 1 && rs.open[0] && !rs.remove && !rs.layers, "removing down to one voice across the keyboard: a single voice, open, no ×", rs);
  await ev(() => window.synthkit.model.history.undo());
  await page.click(".voice:nth-child(2) .voice-toggle");

  // ---- a part in a scale -----------------------------------------------------------------------------
  // (The voice's patch's own sk.scale and sk.scaleKey, on its strip.)
  const scaleSel = ".voice.is-open .voice-scale", keySel = ".voice.is-open .voice-key";
  check(await ev((q) => document.querySelector(q).selectedOptions[0].textContent === "Chromatic", scaleSel) && await ev((q) => document.querySelector(q).hidden, keySel),
    "voices start chromatic, with no key to pick");
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

  // ---- unsaved changes ---------------------------------------------------------------------------
  await page.selectOption(".sound-select", warm);
  await page.waitForSelector(".sk-dialog");
  check(await ev(() => [...document.querySelectorAll(".sk-dialog button")].map((b) => b.textContent).join()) === "Cancel,Don't save,Save" &&
    await ev(() => document.querySelector(".sk-dialog").textContent.includes("My split")), "picking another sound after an edit asks: Cancel, Don't save, Save");
  await page.click(".sk-dialog button[data-value=cancel]");
  check(await ev(() => window.synthkit.app.sound.shown().name === "My split" && window.synthkit.app.sound.dirty && document.querySelector(".sound-select").selectedOptions[0].textContent.startsWith("My split")),
    "Cancel keeps the sound and its changes (and the list shows it)");
  await page.click('.sound button[title^="Next"]');
  await page.waitForSelector(".sk-dialog");
  await page.click(".sk-dialog button[data-value=save]");
  check(await ev(() => window.synthkit.app.sound.userMultis["My split"].parts.some((p) => Math.abs(p.patch.params["filter.cutoff"] - 999) < 1)),
    "Save (on one of your multis) saves it in place, then moves on");
  await ev(() => window.synthkit.model.history.undo());
  await ev(() => window.synthkit.model.set("filter.cutoff", 1200));
  await page.selectOption(".sound-select", warm);
  await page.waitForSelector(".sk-dialog");
  await page.check(".sk-dialog .sk-dont-ask");
  await page.click(".sk-dialog button[data-value=discard]");
  check(await ev(() => window.synthkit.app.sound.plain() && !window.synthkit.prefs.get().warnUnsaved), "Don't save goes on without saving; Don't ask again turns the question off");
  await ev(() => window.synthkit.model.set("filter.cutoff", 1300));
  await page.selectOption(".sound-select", "m:factory:multis/bass-and-pad.json");
  check(await ev(() => !document.querySelector(".sk-dialog") && window.synthkit.model.layout().parts.length === 2), "…and then it doesn't ask");
  // Preferences turn it back on (Cancel changes nothing).
  await page.click(".prefs-btn");
  await page.waitForSelector(".sk-dialog");
  await page.check("#sk-pref-warn");
  await page.click(".sk-dialog button[data-value=cancel]");
  check(await ev(() => !window.synthkit.prefs.get().warnUnsaved), "Preferences' Cancel changes nothing");
  await page.click(".prefs-btn");
  await page.check("#sk-pref-warn");
  await page.click(".sk-dialog button[data-value=save]");
  check(await ev(() => window.synthkit.prefs.get().warnUnsaved), "Preferences' Save turns the warning back on");
  // A sound that isn't yours yet: Save asks for a name first.
  await ev(() => window.synthkit.model.set("filter.cutoff", 1400));
  await page.selectOption(".sound-select", warm);
  await page.waitForSelector(".sk-dialog");
  await page.click(".sk-dialog button[data-value=save]");
  await page.waitForSelector(".sk-dialog .sk-field");
  check(await ev(() => document.querySelector(".sk-dialog .sk-field").value) === "Bass and pad copy", "Save on a factory multi asks for a name (a copy's)");
  await page.keyboard.press("Enter");
  check(await ev(() => !!window.synthkit.app.sound.userMultis["Bass and pad copy"] && window.synthkit.app.sound.plain()), "…saves it under that name and moves on");
  await ev(() => window.synthkit.prefs.set({ warnUnsaved: false }));   // (the rest of the test switches sounds freely)

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
  rs = await rackState();
  check(rs.voices === 2 && rs.open.every((o) => !o) && rs.layers, "…with its voices closed and Layers and splits showing", rs);
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
