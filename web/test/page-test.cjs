// Checks a synth's own page (API.md §9a) and messages (§9b) in headless
// Chromium, using the kit's example examples/reed:
//   node web/test/page-test.cjs <reed.html> <out dir>
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

async function main() {
  const [html, outDir] = process.argv.slice(2);
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const failures = [];
  const fail = (m) => { failures.push(m); console.log("  FAIL  " + m); };
  const pass = (m) => console.log("  PASS  " + m);
  const check = (ok, good, bad) => (ok ? pass(good) : fail(bad));

  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("file://" + path.resolve(html));
  await page.waitForFunction(() => window.synthkit && window.synthkit.model, null, { timeout: 15000 });
  await page.waitForTimeout(200);

  // 1. The page's markup is in, and the kit's parts are where it asked.
  const placed = await page.evaluate(() => ({
    ownPage: document.querySelector("#app").classList.contains("sk-own-page"),
    defaultHeader: !!document.querySelector("header.top"),
    presets: !!document.querySelector(".rail-presets .presets"),
    midi: !!document.querySelector(".rail-actions .midi"),
    panic: !!document.querySelector(".rail-actions button"),
    keyboard: !!document.querySelector(".keybed .keyboard"),
    tempo: !!document.querySelector(".play-btn") && document.querySelector(".play-btn").isConnected,
    knobs: document.querySelectorAll(".voicing .ctl").length,
  }));
  check(placed.ownPage && !placed.defaultHeader, "the synth's own page replaces the kit's", `page: ${JSON.stringify(placed)}`);
  check(placed.presets && placed.midi && placed.panic && placed.keyboard && !placed.tempo,
    "kit parts mount where the page puts them (and the tempo stays out)", `placed: ${JSON.stringify(placed)}`);
  check(placed.knobs === 6, "a section of kit knobs mounts from a layout-style spec", `${placed.knobs} knobs`);

  // 2. A treadle press is a message; pumping raises the pressure the gauge shows.
  await page.mouse.click(5, 5);
  await page.waitForFunction(() => window.synthkit.app.audio.running, null, { timeout: 10000 });
  await page.evaluate(() => window.synthkit.model.set("wind.helper", 0));
  const gauge = () => page.evaluate(() => Number(document.querySelector(".gauge").getAttribute("aria-valuenow")));
  const before = await gauge();
  const left = page.locator('.treadle[data-foot="left"]');
  const box = await left.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(900);
  const pressed = await left.getAttribute("aria-pressed");
  await page.mouse.up();
  await page.waitForTimeout(150);
  const after = await gauge();
  check(pressed === "true" && after > before + 0.3, `pumping fills the reservoir (gauge ${before.toFixed(2)} → ${after.toFixed(2)}″)`,
    `treadle pressed=${pressed}, gauge ${before} → ${after}`);
  check(await left.getAttribute("aria-pressed") === "false", "letting go of the treadle lets it up", "treadle stuck down");

  // 3. Arrow keys work the treadles too, and computer keys play (the page mounted the keyboard).
  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(100);
  check(await page.locator('.treadle[data-foot="right"]').getAttribute("aria-pressed") === "true", "arrow keys pump", "ArrowRight didn't press the treadle");
  await page.keyboard.up("ArrowRight");
  await page.keyboard.down("a");
  await page.waitForTimeout(300);
  const voices = await page.evaluate(() => window.synthkit.app.voices.textContent);
  await page.keyboard.up("a");
  check(/^[1-9]/.test(voices), `computer keys play (${voices})`, `typing A gave "${voices}"`);

  // 4. The bridge's presets and settings.
  const presets = await page.evaluate(() => {
    const sk = window.synthkit.app.pageApi();
    const seen = [];
    const off = sk.presets.onChange((s) => seen.push({ ...s }));
    sk.set("reed.bright", 0.9);
    const dirty = sk.presets.current().dirty;
    sk.presets.saveAs("Page test");
    const saved = sk.presets.current();
    const listed = sk.presets.list().some((p) => p.name === "Page test" && p.kind === "user");
    sk.set("reed.bright", 0.1);
    sk.presets.revert();
    const reverted = sk.get("reed.bright");
    sk.presets.load("Full Swell", "factory");
    const swell = sk.get("swell");
    sk.store.set("look", { open: true });
    const stored = sk.store.get("look", null);
    off();
    return { dirty, saved, listed, reverted, swell, stored, events: seen.length };
  });
  check(presets.dirty && presets.saved.name === "Page test" && presets.saved.kind === "user" && !presets.saved.dirty && presets.listed,
    "presets: changes mark the sound edited, and Save as… stores it", `presets: ${JSON.stringify(presets)}`);
  check(Math.abs(presets.reverted - 0.9) < 1e-6 && presets.swell === 1 && presets.events > 0,
    "presets: revert, load and change notifications", `presets: ${JSON.stringify(presets)}`);
  check(presets.stored && presets.stored.open === true, "settings store keeps the page's own settings", `store gave ${JSON.stringify(presets.stored)}`);

  // 5. The page's look: screenshots, and no sideways scrolling on a phone.
  await page.screenshot({ path: path.join(outDir, "page-desktop.png"), fullPage: true });
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  phone.on("pageerror", (e) => errors.push(String(e)));
  await phone.goto("file://" + path.resolve(html));
  await phone.waitForFunction(() => window.synthkit && window.synthkit.model);
  await phone.waitForTimeout(200);
  await phone.screenshot({ path: path.join(outDir, "page-phone.png"), fullPage: true });
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 1, "phone: no sideways scrolling", `phone page scrolls sideways by ${overflow}px`);

  // 6. The same page in the plugin window (a stand-in for JUCE's bridge, as in
  // plugin-ui-test.cjs): messages go to the plugin, meters and messages come back.
  const plug = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  plug.on("pageerror", (e) => errors.push(String(e)));
  plug.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await plug.addInitScript(() => {
    window.__skHost = { format: "VST3", host: "Test", state: { patch: { synth: "sk-reed", name: "Init", params: {} }, ui: {} }, store: {} };
    const listeners = new Map();
    window.__sent = [];
    window.__JUCE__ = { backend: {
      addEventListener: (id, fn) => { if (!listeners.has(id)) listeners.set(id, []); listeners.get(id).push(fn); },
      emitEvent: (id, payload) => window.__sent.push(JSON.parse(JSON.stringify(payload))),
    } };
    window.__deliver = (msg) => (listeners.get("sk") || []).forEach((fn) => fn(JSON.parse(JSON.stringify(msg))));
  });
  await plug.goto("file://" + path.resolve(html));
  await plug.waitForFunction(() => window.synthkit && window.synthkit.model);
  const tb = await plug.locator('.treadle[data-foot="left"]').boundingBox();
  await plug.mouse.move(tb.x + 20, tb.y + 20);
  await plug.mouse.down();
  await plug.mouse.up();
  const sentMsgs = await plug.evaluate(() => window.__sent.filter((m) => m.t === "msg"));
  const leftIndex = await plug.evaluate(() => window.synthkit.model.info.messages.indexOf("treadle.left"));
  check(sentMsgs.length === 2 && sentMsgs.every((m) => m.i === leftIndex) && sentMsgs[0].v[0] === 1 && sentMsgs[1].v[0] === 0,
    "plugin: treadle messages go to the plugin", `sent ${JSON.stringify(sentMsgs)}`);
  const shown = await plug.evaluate(() => {
    const m = window.synthkit.model;
    const mod = new Array(m.mod.sources.length + m.params.length).fill(null);
    mod[m.sourceIndex.get("wind.pressure")] = 0.5;
    window.__deliver({ t: "meter", voices: 0, limiterDb: 0, peak: 0, beat: 0, playing: false, bpm: 120, num: 4, den: 4, scope: [], mod });
    window.__deliver({ t: "msgs", list: [[m.info.messages.indexOf("wind.valve"), [1]]] });
    return { gauge: Number(document.querySelector(".gauge").getAttribute("aria-valuenow")), valve: !document.querySelector(".gauge-valve").hidden,
             midi: !!document.querySelector(".rail-actions .midi") };
  });
  check(Math.abs(shown.gauge - 1.8) < 0.01 && shown.valve && !shown.midi,
    "plugin: the gauge follows the plugin's meters, its messages show, and MIDI is left to the DAW", `plugin page: ${JSON.stringify(shown)}`);
  await plug.screenshot({ path: path.join(outDir, "page-plugin.png") });

  check(errors.length === 0, "no console errors", `console errors: ${errors.join(" | ")}`);
  await browser.close();
  console.log(failures.length ? `FAILED: ${failures.length}` : "OK");
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
