// Headless-Chromium checks for a packed synth page:
//   node web/test/browser-test.cjs <synth.html> <out dir> [scenario.json]
// - the page boots with no console errors, at desktop and phone width
//   (screenshots written to <out dir>)
// - playing from the computer keyboard starts voices
// - a scenario rendered offline through the real AudioWorklet is written
//   to <out dir>/web-render.f32 for comparison with the native renderer
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

  for (const [name, vp] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport: vp });
    const errors = [];
    // Web fonts may be unreachable (offline, sandboxed CI); that's not a page error.
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    page.on("requestfailed", (r) => { if (!/fonts\.(googleapis|gstatic)\.com/.test(r.url())) errors.push("request failed: " + r.url()); });
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(url);
    await page.waitForFunction(() => window.synthkit && window.synthkit.model, null, { timeout: 15000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outDir, `ui-${name}.png`), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 1) fail(`${name}: page scrolls sideways by ${overflow}px`);
    if (name === "desktop") {
      // Start audio and play a chord from the computer keyboard.
      await page.mouse.click(5, 5);
      await page.waitForFunction(() => window.synthkit.app.audio.running, null, { timeout: 10000 });
      for (const k of ["a", "d", "g"]) await page.keyboard.down(k);
      await page.waitForTimeout(500);
      const voices = await page.evaluate(() => document.querySelector(".voice-count").textContent);
      if (!/^[1-9]/.test(voices)) fail(`keyboard didn't start voices (meter says "${voices}")`); else pass(`computer keyboard plays (${voices})`);
      for (const k of ["a", "d", "g"]) await page.keyboard.up(k);
      // Knob via keyboard focus + arrows changes the model and the readout.
      const cut = page.locator('[data-param="filter.cutoff"] .knob-dial');
      const before = await page.evaluate(() => window.synthkit.model.get("filter.cutoff"));
      await cut.focus();
      for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowUp");
      const after = await page.evaluate(() => window.synthkit.model.get("filter.cutoff"));
      if (!(after > before)) fail("arrow keys didn't move the cutoff knob"); else pass(`cutoff knob responds (${before.toFixed(0)} → ${after.toFixed(0)} Hz)`);
      // Typing a value.
      await page.locator('[data-param="filter.cutoff"] .ctl-value').click();
      await page.keyboard.press("Control+A");
      await page.keyboard.type("800");
      await page.keyboard.press("Enter");
      const typed = await page.evaluate(() => window.synthkit.model.get("filter.cutoff"));
      if (Math.abs(typed - 800) > 1) fail(`typing 800 set cutoff to ${typed}`); else pass("typing a value works");
      // Presets: pick another factory preset, then the session survives a reload.
      await page.selectOption(".preset-select", { label: "Pluck" });
      const res = await page.evaluate(() => window.synthkit.model.get("filter.cutoff"));
      if (Math.abs(res - 260) > 1) fail(`loading Pluck set cutoff to ${res}`); else pass("factory preset loads");
      await page.waitForTimeout(600);
      await page.reload();
      await page.waitForFunction(() => window.synthkit && window.synthkit.model);
      const name2 = await page.evaluate(() => window.synthkit.model.patchName);
      if (name2 !== "Pluck") fail(`session restore gave "${name2}"`); else pass("session is restored after reload");
      await page.screenshot({ path: path.join(outDir, "ui-desktop-dark.png"), fullPage: false });
    }
    if (errors.length) fail(`${name}: console errors: ${errors.join(" | ")}`); else pass(`${name}: boots with no console errors`);
    await page.close();
  }

  // Dark theme screenshot.
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
    await page.goto(url);
    await page.waitForFunction(() => window.synthkit && window.synthkit.model);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(outDir, "ui-dark.png"), fullPage: true });
    await page.close();
  }

  if (scenarioPath) {
    const sc = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.synthkit && window.synthkit.model);
    const out = await page.evaluate(async (sc) => {
      const sk = window.synthkit;
      const preset = sk.model.info.presets.find((p) => p.path.endsWith("/" + sc.patch + ".json"));
      if (!sk.model.loadPatch(preset.patch).ok) throw new Error("patch load failed");
      for (const [k, v] of Object.entries(sc.params || {})) sk.model.set(k, v);
      const bpm = (sc.transport || {}).bpm || 120;
      const toSec = (e) => (e.beat !== undefined ? (e.beat * 60) / bpm : e.t);
      const events = sc.events.map((e) => ({
        t: toSec(e),
        d: e.on !== undefined ? [0x90, e.on, e.vel ?? 100] : e.off !== undefined ? [0x80, e.off, 64]
          : e.cc !== undefined ? [0xb0, e.cc, e.value] : [0xe0, 0, 64],
      }));
      const seconds = sc.lengthBeats ? (sc.lengthBeats * 60) / bpm : sc.length;
      const tr = sc.transport || {};
      const r = await sk.renderOffline({ events, seconds, sampleRate: 48000,
        transport: { bpm, playing: !!tr.playing, num: (tr.timeSig || [4])[0], den: (tr.timeSig || [4, 4])[1] } });
      return { left: Array.from(r.left), right: Array.from(r.right) };
    }, sc);
    const n = out.left.length;
    const buf = Buffer.alloc(n * 8);
    for (let i = 0; i < n; i++) { buf.writeFloatLE(out.left[i], i * 8); buf.writeFloatLE(out.right[i], i * 8 + 4); }
    fs.writeFileSync(path.join(outDir, "web-render.f32"), buf);
    pass(`offline render through the worklet: ${(n / 48000).toFixed(2)} s`);
    await page.close();
  }

  await browser.close();
  console.log(failures.length ? `FAILED: ${failures.length}` : "OK");
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
