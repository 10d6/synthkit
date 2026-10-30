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

      if (await page.evaluate(() => window.synthkit.model.mod.slots > 0)) {
        // Modulate a knob from its menu.
        const before = await page.evaluate(() => window.synthkit.model.routes().length);
        await page.click('[data-param="filter.cutoff"] .knob-dial', { button: "right" });
        await page.click('.menu-item:has-text("Modulate")');
        await page.click('.menu-item:has-text("LFO 1")');
        const after = await page.evaluate(() => window.synthkit.model.routes());
        if (after.length !== before + 1 || after[after.length - 1].dst !== "filter.cutoff") fail("Modulate… didn't add an LFO 1 → cutoff route");
        else pass("right-click → Modulate adds a route");
        // Add a point in the first shape editor.
        const pts = await page.evaluate(() => window.synthkit.model.shapes()[0].curves[0].points.length);
        await page.evaluate(() => document.querySelector(".shape-svg").scrollIntoView({ block: "center" }));
        const box = await page.locator(".shape-svg").first().boundingBox();
        await page.mouse.dblclick(box.x + box.width * 0.37, box.y + box.height * 0.3);
        const pts2 = await page.evaluate(() => window.synthkit.model.shapes()[0].curves[0].points.length);
        if (pts2 !== pts + 1) fail(`double-click in the shape editor gave ${pts2} points (had ${pts})`); else pass("shape editor adds points");
        // Double-click the new point to remove it again.
        const added = await page.evaluate(() => {
          const ed = document.querySelector(".shape-svg");
          const c = [...ed.querySelectorAll(".shape-point")].map((e) => e.getBoundingClientRect());
          return c.map((r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 }));
        });
        const mid = added[1];
        await page.mouse.dblclick(mid.x, mid.y);
        const pts3 = await page.evaluate(() => window.synthkit.model.shapes()[0].curves[0].points.length);
        if (pts3 !== pts) fail(`double-clicking a point left ${pts3} points (expected ${pts})`); else pass("double-clicking a point removes it");
        // Handles: select the middle point of a fresh 3-point curve, drag its
        // out handle; the in handle mirrors it. Alt-drag breaks the pair.
        await page.evaluate(() => {
          const m = window.synthkit.model, sh = m.shapes();
          sh[0].curves[0] = { points: [[0, 0, 0, 0, 0, 0, 0, 0, 0], [0.5, 0.5, 0, 0, 0, 0, 0, 0, 0], [1, 1, 0, 0, 0, 0, 0, 0, 0]] };
          m.setShapes(sh);
        });
        const geo = await page.evaluate(() => {
          const ed = document.querySelector(".shape-svg").getBoundingClientRect();
          return { x: ed.x, y: ed.y, w: ed.width, h: ed.height };
        });
        const ptX = geo.x + 10 + 0.5 * (geo.w - 20), ptY = geo.y + 10 + 0.5 * (geo.h - 20);
        await page.mouse.click(ptX, ptY);
        await page.waitForTimeout(450);  // not a double-click
        const knobs = await page.evaluate(() => [...document.querySelectorAll(".handle-knob")].map((k) => { const r = k.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }));
        if (knobs.length !== 2) fail(`selecting a point showed ${knobs.length} handles`);
        else {
          const outK = knobs.reduce((a, k) => (k.x > a.x ? k : a));
          await page.mouse.move(outK.x, outK.y);
          await page.mouse.down();
          await page.mouse.move(outK.x + 30, outK.y - 40, { steps: 4 });
          await page.mouse.up();
          const p = await page.evaluate(() => window.synthkit.model.shapes()[0].curves[0].points[1]);
          const mirrored = p[5] > 0 && p[7] < 0 && Math.abs(p[5] / p[4] - p[7] / p[6]) < 0.05;
          if (!(p[4] > 0) || !mirrored) fail(`handle drag gave ${JSON.stringify(p)}`); else pass("dragging a handle curves the line; its partner mirrors it");
          await page.waitForTimeout(450);
          const k2 = await page.evaluate(() => [...document.querySelectorAll(".handle-knob")].map((k) => { const r = k.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }));
          const inK = k2.reduce((a, k) => (k.x < a.x ? k : a));
          await page.keyboard.down("Alt");
          await page.mouse.move(inK.x, inK.y);
          await page.mouse.down();
          await page.mouse.move(inK.x, inK.y + 30, { steps: 3 });
          await page.mouse.up();
          await page.keyboard.up("Alt");
          const q = await page.evaluate(() => window.synthkit.model.shapes()[0].curves[0].points[1]);
          if (q[8] !== 1 || Math.abs(q[5] - p[5]) > 1e-6) fail(`Alt-drag gave ${JSON.stringify(q)}`); else pass("Alt-drag moves one handle on its own");
        }
        // The page's curve maths matches the engine's (S-curve, see core tests).
        const sv = await page.evaluate(() => window.synthkit.evalCurve([[0, 0, 0, 0, 1 / 3, 0, 0, 0, 0], [1, 1, 0, 0, 0, 0, -1 / 3, 0, 0]], 0.25));
        if (Math.abs(sv - 0.15625) > 0.002) fail(`page curve maths gave ${sv} (engine: 0.15625)`); else pass("page and engine curve maths agree");

        // With nothing playing, live displays rest.
        await page.evaluate(() => window.synthkit.app.audio.send({ t: "panic" }));
        await page.waitForTimeout(400);
        const idle = await page.evaluate(() => ({
          rings: document.querySelectorAll(".ctl.is-modulated").length,
          dots: [...document.querySelectorAll(".lfo-dot")].filter((d) => d.getAttribute("visibility") !== "hidden").length,
          heads: [...document.querySelectorAll(".shape-head")].filter((d) => d.getAttribute("visibility") !== "hidden").length,
        }));
        if (idle.rings || idle.dots || idle.heads) fail(`live displays still moving with nothing playing: ${JSON.stringify(idle)}`); else pass("nothing animates while nothing plays");
        // Follow MIDI clock: start + 48 ticks at 120 BPM.
        const clock = await page.evaluate(() => {
          const app = window.synthkit.app;
          app.clockSource = "midi";
          app.clock.message([0xfa], 0);
          for (let i = 1; i <= 48; i++) app.clock.message([0xf8], i * (500 / 24));
          return { bpm: app.transport.bpm, playing: app.transport.playing };
        });
        if (!clock.playing || Math.abs(clock.bpm - 120) > 1) fail(`MIDI clock follow gave ${JSON.stringify(clock)}`); else pass(`follows MIDI clock (${clock.bpm} BPM)`);
      }
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
