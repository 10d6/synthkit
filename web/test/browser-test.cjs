// Headless-Chromium checks for a packed synth page:
//   node web/test/browser-test.cjs <synth.html> <out dir> [scenario.json] [--kit-ui]
// - the page boots with no console errors, at desktop and phone width
//   (screenshots written to <out dir>)
// - playing from the computer keyboard (or, on a synth's own page without
//   the kit's keyboard, the page's note calls) starts voices
// - a scenario rendered offline through the real AudioWorklet is written
//   to <out dir>/web-render.f32 for comparison with the native renderer
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

async function main() {
  const args = process.argv.slice(2);
  // --kit-ui: also run the kit's UI tests, which use the example synth's
  // controls and presets (synthkit's own CI). Synth repos run the rest.
  const kitUi = args.includes("--kit-ui");
  const [html, outDir, scenarioPath] = args.filter((a) => !a.startsWith("--"));
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
      // (A synth's own page may leave the kit's keyboard out, API.md §9a; then
      // play the same chord through the page's note calls.)
      const typing = await page.evaluate(() => window.synthkit.app.keyboard.typing);
      if (typing) for (const k of ["a", "d", "g"]) await page.keyboard.down(k);
      else await page.evaluate(() => { for (const n of [60, 64, 67]) window.synthkit.app.noteOn(n, 100); });
      await page.waitForTimeout(500);
      const voices = await page.evaluate(() => window.synthkit.app.voices.textContent);
      const how = typing ? "computer keyboard" : "page's note calls";
      if (!/^[1-9]/.test(voices)) fail(`${how} didn't start voices (meter says "${voices}")`);
      else pass(`${typing ? "computer keyboard plays" : "page's note calls play"} (${voices})`);
      if (typing) for (const k of ["a", "d", "g"]) await page.keyboard.up(k);
      else await page.evaluate(() => { for (const n of [60, 64, 67]) window.synthkit.app.noteOff(n); });
      if (kitUi) {
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
        // A handle can still be grabbed after text on the page got selected
        // (selected text used to hijack the next drag).
        {
          await page.evaluate(() => {
            const m = window.synthkit.model, sh = m.shapes();
            sh[0].curves[0] = { points: [[0, 0, 0, 0, 0, 0, 0, 0, 0], [0.5, 0.5, 0, 0, 0, 0, 0, 0, 0], [1, 1, 0, 0, 0, 0, 0, 0, 0]] };
            m.setShapes(sh);
            const hint = document.querySelector(".shape-hint");
            const r = document.createRange(); r.selectNodeContents(hint);
            const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
          });
          await page.mouse.click(ptX, ptY);
          await page.waitForTimeout(450);
          await page.evaluate(() => {  // select the hint again, as a stray drag would
            const r = document.createRange(); r.selectNodeContents(document.querySelector(".shape-hint"));
            const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
          });
          const k3 = await page.evaluate(() => [...document.querySelectorAll(".handle-knob")].map((k) => { const r = k.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }));
          const o3 = k3.reduce((a, k) => (k.x > a.x ? k : a));
          // Drag the handle and drift up out of the editor, across the hint text.
          const hintBox = await page.locator(".shape-hint").first().boundingBox();
          await page.mouse.move(o3.x, o3.y);
          await page.mouse.down();
          await page.mouse.move(o3.x + 20, o3.y - 35, { steps: 5 });
          await page.mouse.move(hintBox.x + 40, hintBox.y + hintBox.height / 2, { steps: 6 });
          await page.mouse.move(o3.x + 20, o3.y - 35, { steps: 6 });
          await page.mouse.up();
          const p3 = await page.evaluate(() => window.synthkit.model.shapes()[0].curves[0].points[1]);
          const selText = await page.evaluate(() => String(window.getSelection()));
          if (!(p3[5] > 0.05)) fail(`couldn't drag a handle with text selected (point ${JSON.stringify(p3)})`); else pass("handles can be dragged even with text selected");
          if (selText) fail("dragging in the editor left text selected");
        }

        // Handles stay inside the editor: on every factory curve, on an old
        // patch whose handle is far outside (shown pinned to the edge), and
        // after dragging a handle well past the edge.
        {
          const inside = () => page.evaluate(() => {
            const ed = document.querySelector(".shape-svg").getBoundingClientRect();
            return [...document.querySelectorAll(".handle-knob")].every((k) => {
              const r = k.getBoundingClientRect(), cy = r.y + r.height / 2, cx = r.x + r.width / 2;
              return cy >= ed.y && cy <= ed.y + ed.height && cx >= ed.x && cx <= ed.x + ed.width;
            });
          });
          const pointPos = (i) => page.evaluate((i) => { const r = document.querySelectorAll(".shape-svg")[0].querySelectorAll(".shape-point")[i].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, i);
          const presets = ["Ramp down", "Ramp up", "Pump", "Swell", "Triangle", "Square"];
          let bad = [];
          for (const name of presets) {
            // Factory curves are in the older format, so their handles come from the fit.
            await page.locator(".shape-editor").first().locator('button:has-text("Curves")').click();
            await page.click(`.menu-item:text-is("${name}")`);
            const n = await page.evaluate(() => window.synthkit.model.shapes()[0].curves[0].points.length);
            for (let i = 0; i < n; i++) {
              const pp = await pointPos(i);
              await page.mouse.click(pp.x, pp.y);
              await page.waitForTimeout(420);
              if (!(await inside())) bad.push(`${name} point ${i + 1}`);
            }
          }
          if (bad.length) fail(`handles drawn outside the editor: ${bad.join(", ")}`); else pass("factory curves' handles are all inside the editor");

          await page.evaluate(() => {
            const m = window.synthkit.model, sh = m.shapes();
            sh[0].curves[0] = { points: [[0, 1, 0, 0, 0.3, -1.5, 0, 0, 1], [1, 0, 0, 0, 0, 0, -0.3, 0, 1]] };
            m.setShapes(sh);
          });
          const p0 = await pointPos(0);
          await page.mouse.click(p0.x, p0.y);
          await page.waitForTimeout(420);
          const pinned = await page.evaluate(() => document.querySelectorAll(".handle-knob.is-pinned").length);
          if (!(await inside()) || pinned !== 1) fail(`an outside handle wasn't pinned to the edge (pinned ${pinned})`);
          else {
            const k = await page.evaluate(() => { const r = document.querySelector(".handle-knob.is-pinned").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
            await page.mouse.move(k.x, k.y);
            await page.mouse.down();
            await page.mouse.move(k.x + 10, k.y + 200, { steps: 6 });   // well past the bottom
            await page.mouse.up();
            const q = await page.evaluate(() => window.synthkit.model.shapes()[0].curves[0].points[0]);
            if (Math.abs(q[1] + q[5]) > 1e-6) fail(`dragging a pinned handle past the edge gave ${JSON.stringify(q)}`);
            else pass("an outside handle shows on the edge, can be grabbed, and drags stop at the edge");
          }
        }

        // The modulation amount follows a full drag (the matrix used to rebuild
        // its rows mid-drag, ending the drag after the first few percent).
        {
          await page.evaluate(() => document.querySelector(".matrix-panel").scrollIntoView({ block: "center" }));
          const routes0 = await page.evaluate(() => window.synthkit.model.routes());
          const idx = routes0.length - 1;
          const tr = await page.evaluate((i) => { const r = document.querySelectorAll(".amt-track")[i].getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, idx);
          const startX = tr.x + tr.w / 2, y0 = tr.y + tr.h / 2;
          await page.mouse.move(startX, y0);
          await page.mouse.down();
          // Drift vertically as a real hand would.
          for (let k = 1; k <= 10; k++) await page.mouse.move(startX + k * 6, y0 + (k % 3) * 9);
          await page.mouse.up();
          const a1 = await page.evaluate((i) => window.synthkit.model.routes()[i].amt, idx);
          const expected = routes0[idx].amt + (60 / tr.w) * 2;
          if (Math.abs(a1 - Math.min(1, expected)) > 0.05) fail(`amount drag moved ${routes0[idx].amt.toFixed(2)} → ${a1.toFixed(2)} (expected ≈ ${Math.min(1, expected).toFixed(2)})`);
          else pass(`modulation amount follows the whole drag (${(routes0[idx].amt * 100).toFixed(0)}% → ${(a1 * 100).toFixed(0)}%)`);
        }

        // Editing one shape never undoes another shape's edits.
        {
          const eds = await page.evaluate(() => [...document.querySelectorAll(".shape-svg")].map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }));
          if (eds.length >= 2) {
            const addAt = async (i, fx, fy) => {
              await page.evaluate((i) => document.querySelectorAll(".shape-svg")[i].scrollIntoView({ block: "center" }), i);
              const r = await page.evaluate((i) => { const e = document.querySelectorAll(".shape-svg")[i].getBoundingClientRect(); return { x: e.x, y: e.y, w: e.width, h: e.height }; }, i);
              await page.waitForTimeout(450);
              await page.mouse.dblclick(r.x + 10 + fx * (r.w - 20), r.y + 10 + (1 - fy) * (r.h - 20));
            };
            const before = await page.evaluate(() => window.synthkit.model.shapes().map((s) => s.curves[0].points.length));
            await addAt(0, 0.3125, 0.3);
            await addAt(1, 0.4375, 0.6);
            await addAt(0, 0.8125, 0.4);
            const after = await page.evaluate(() => window.synthkit.model.shapes().map((s) => s.curves[0].points.length));
            if (after[0] !== before[0] + 2 || after[1] !== before[1] + 1) fail(`editing shapes in turn: points ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
            else pass("editing one shape keeps the other shape's edits");
          }
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
        await page.evaluate(() => { const app = window.synthkit.app; app.clockSource = "internal"; });

        // Messages (API.md §9b): the "Clear echoes" widget sends delay.clear,
        // and the synth's delay.cleared answer shows up in the widget.
        await page.locator(".ctl-custom button", { hasText: "Clear echoes" }).click();
        try {
          await page.waitForFunction(() => document.querySelector(".clear-note").textContent === "Cleared", null, { timeout: 3000 });
          pass("a message reaches the synth and its answer comes back");
        } catch { fail("Clear echoes: no delay.cleared message came back"); }
      }
      }  // kitUi
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
      const events = sc.events.map((e) => (e.msg !== undefined
        ? { t: toSec(e), m: [sk.model.info.messages.indexOf(e.msg), e.values || []] }
        : {
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
