// Headless-Chromium checks for a packed synth page:
//   node web/test/browser-test.cjs <synth.html> <out dir> [scenario.json] [--kit-ui]
// - the page boots with no console errors, at desktop and phone width
//   (screenshots written to <out dir>)
// - under a real browser's autoplay rule, the first click starts the sound;
//   a (fake) MIDI keyboard plays it and mapped controllers move parameters
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
      // This test switches sounds after editing them; the unsaved-changes
      // question (multi-test.cjs tests it) would stop it.
      await page.evaluate(() => window.synthkit.prefs.set({ warnUnsaved: false }));
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
        await page.click('.pick-pop .pick-cat:text-is("LFOs")');
        await page.click('.pick-pop .pick-item:has-text("LFO 1")');
        const after = await page.evaluate(() => window.synthkit.model.routes());
        if (after.length !== before + 1 || after[after.length - 1].dst !== "filter.cutoff") fail("Modulate… didn't add an LFO 1 → cutoff route");
        else pass("right-click → Modulate adds a route");
        // Tabs, accordions and info icons (the example's layout uses all three).
        {
          const vis = (sel) => page.evaluate((sel) => { const e = document.querySelector(sel); return !!e && e.getClientRects().length > 0; }, sel);
          const selected = () => page.evaluate(() => [...document.querySelectorAll(".tab")].filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.textContent));
          const s0 = await selected();
          if (s0.join() !== "LFOs" || !(await vis(".lfo-panel")) || (await vis(".shape-svg"))) fail(`tabs at start: selected ${JSON.stringify(s0)}, LFO shown ${await vis(".lfo-panel")}, shape shown ${await vis(".shape-svg")}`);
          await page.click('.tab:text-is("Shapes")');
          const s1 = await selected();
          if (s1.join() !== "Shapes" || (await vis(".lfo-panel")) || !(await vis(".shape-svg"))) fail(`clicking the Shapes tab: selected ${JSON.stringify(s1)}`);
          else pass("tabs switch between groups of panels");
          await page.focus('.tab:text-is("Shapes")');
          await page.keyboard.press("ArrowLeft");
          const s2 = await selected();
          await page.keyboard.press("End");
          const s3 = await selected();
          const kept = await page.evaluate(() => JSON.parse(localStorage.getItem(`synthkit:${window.synthkit.model.info.synth.id}:ui`) || "{}"));
          if (s2.join() !== "LFOs" || s3.join() !== "Shapes") fail(`arrow keys on tabs gave ${s2} then ${s3}`);
          else if (!Object.values(kept).includes("Shapes")) fail(`the chosen tab isn't remembered: ${JSON.stringify(kept)}`);
          else pass("tabs follow arrow keys and remember the choice");
          // Accordion: Voices starts folded; its title opens it.
          const toggle = page.locator('.panel-toggle:has-text("Voicing")');
          const exp0 = await toggle.getAttribute("aria-expanded");
          const glide0 = await vis('[data-param="glide"]');
          await toggle.click();
          const exp1 = await toggle.getAttribute("aria-expanded");
          const glide1 = await vis('[data-param="glide"]');
          await toggle.click();
          if (exp0 !== "false" || glide0 || exp1 !== "true" || !glide1) fail(`accordion: folded ${exp0}/${glide0}, opened ${exp1}/${glide1}`);
          else pass("accordion panels fold and open at their titles");
          // A folding pattern panel keeps its toggle when it renames itself (Arp ↔ Sequencer pattern).
          const patTitle = () => page.evaluate(() => { const t = document.querySelector(".arp-pattern-panel > .panel-title"); return t && { toggle: !!t.querySelector(".panel-toggle"), text: t.textContent }; });
          const arpWas = await page.evaluate(() => window.synthkit.model.get("arp.on"));
          await page.evaluate(() => window.synthkit.model.set("arp.on", 2));
          const pt = await patTitle();
          await page.evaluate((v) => window.synthkit.model.set("arp.on", v), arpWas);
          if (!pt || !pt.toggle || !/Sequencer pattern/.test(pt.text)) fail(`pattern panel title after switching to the sequencer: ${JSON.stringify(pt)}`);
          else pass("the pattern panel keeps its fold toggle when it renames itself");
          // Info icons: on a control, a kit control (paramInfo) and a panel.
          await page.click('[data-param="filter.drive"] .info-btn');
          const pop = await page.evaluate(() => { const p = document.querySelector(".info-pop"); return p && !p.hidden ? p.textContent : null; });
          await page.click(".synth-name");
          const gone = await page.evaluate(() => document.querySelector(".info-pop").hidden);
          const counts = await page.evaluate(() => ({ a4: document.querySelectorAll('[data-param="sk.a4"] .info-btn').length, panel: document.querySelectorAll(".matrix-panel > .panel-title .info-btn").length }));
          if (!pop || !/Saturation/.test(pop) || !gone) fail(`info popover: text ${JSON.stringify(pop)}, closes on outside click ${gone}`);
          else if (counts.a4 !== 1 || counts.panel !== 1) fail(`info icons missing: ${JSON.stringify(counts)}`);
          else pass("info icons show their text on controls, kit controls and panels");
          await page.evaluate(() => document.querySelector('[data-param="filter.drive"] .info-btn').scrollIntoView({ block: "center" }));
          await page.hover('[data-param="filter.drive"] .info-btn');
          const hov = await page.evaluate(() => !document.querySelector(".info-pop").hidden);
          await page.mouse.move(2, 2);
          const unhov = await page.evaluate(() => document.querySelector(".info-pop").hidden);
          if (!hov || !unhov) fail(`info on hover: shows ${hov}, hides ${unhov}`); else pass("info shows on hover");
        }
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

        // The source picker: search, a controller by number, and "scaled by".
        {
          const idx = (await page.evaluate(() => window.synthkit.model.routes().length)) - 1;
          const srcBtn = `.route:nth-child(${idx + 1}) .route-src .pick-btn`;
          await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: "center" }), srcBtn);
          await page.click(srcBtn);
          await page.fill(".pick-pop .pick-search", "expression");
          await page.click('.pick-pop .pick-item:has-text("Expression")');
          let r = await page.evaluate((i) => window.synthkit.model.routes()[i], idx);
          if (r.src !== "cc.11") fail(`searching the source picker gave ${r.src}`); else pass("source picker: search finds CC 11 Expression");
          await page.click(srcBtn);
          await page.click('.pick-pop .pick-cat:text-is("MIDI CC")');
          await page.fill(".pick-pop .pick-num", "74");
          await page.keyboard.press("Enter");
          r = await page.evaluate((i) => window.synthkit.model.routes()[i], idx);
          if (r.src !== "cc.74") fail(`typing a CC number gave ${r.src}`); else pass("source picker: any CC by number");
          await page.click(`.route:nth-child(${idx + 1}) .route-via .pick-btn`);
          await page.click('.pick-pop .pick-cat:text-is("Note")');
          await page.click('.pick-pop .pick-item:has-text("Release Velocity")');
          r = await page.evaluate((i) => window.synthkit.model.routes()[i], idx);
          await page.click(`.route:nth-child(${idx + 1}) .route-via .pick-btn`);
          await page.keyboard.press("Escape");
          const open = await page.evaluate(() => !!document.querySelector(".pick-pop"));
          if (r.via !== "release.vel" || open) fail(`"scaled by" picker: via ${r.via}, still open after Esc: ${open}`); else pass("scaled-by picker works and Esc closes it");
          // Put the route back as it was.
          await page.evaluate((i) => { const m = window.synthkit.model, rs = m.routes(); rs[i].src = "lfo1"; delete rs[i].via; m.setRoutes(rs); }, idx);
        }

        // Greyed-out controls follow the settings that make them matter.
        {
          const dim = (id) => page.evaluate((id) => { const e = document.querySelector(`.ctl[data-param="${id}"]`); return e ? e.classList.contains("is-disabled") : null; }, id);
          const set = (id, v) => page.evaluate(([id, v]) => window.synthkit.model.set(id, v, "ui"), [id, v]);
          const was = await page.evaluate(() => ({ mode: window.synthkit.model.get("voiceMode"), uni: window.synthkit.model.get("unison") }));
          await set("voiceMode", 0); await set("unison", 1); await page.waitForTimeout(50);
          const a = [await dim("glide"), await dim("unisonDetune"), await dim("unison")];
          await set("voiceMode", 1); await set("unison", 3); await page.waitForTimeout(50);
          const b = [await dim("glide"), await dim("unisonDetune")];
          await set("voiceMode", was.mode); await set("unison", was.uni);
          if (a.join() !== "true,true,false" || b.join() !== "false,false") fail(`greying out: poly/1 voice ${a}, mono/3 voices ${b}`);
          else pass("Glide and Unison Detune grey out when they do nothing");
        }

        // The on-screen keyboard: lower on a key is louder, and where you let
        // go is the key-up velocity.
        {
          await page.evaluate(() => { const app = window.synthkit.app; app.sentMidi = []; const send = app.sendMidi.bind(app); app.sendMidi = (b, ...r) => { app.sentMidi.push([...b]); return send(b, ...r); }; });
          const k = await page.evaluate(() => { const e = document.querySelector('.key-white[data-note="60"]'); e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y, h: r.height }; });
          await page.mouse.move(k.x, k.y + k.h * 0.75); await page.mouse.down(); await page.mouse.move(k.x, k.y + k.h * 0.95); await page.mouse.up();
          await page.mouse.move(k.x, k.y + k.h * 0.70); await page.mouse.down(); await page.mouse.move(k.x, k.y + k.h * 0.72); await page.mouse.up();
          const sent = await page.evaluate(() => window.synthkit.app.sentMidi.filter((b) => (b[0] & 0xe0) === 0x80 && b[1] === 60));
          const ons = sent.filter((b) => b[0] === 0x90).map((b) => b[2]), offs = sent.filter((b) => b[0] === 0x80).map((b) => b[2]);
          if (ons.length !== 2 || offs.length !== 2 || !(offs[0] > offs[1]) || ons[0] < 20 || ons[0] > 127) fail(`keyboard velocities: on ${ons}, off ${offs}`);
          else pass(`keyboard: velocity follows where you click (on ${ons}, key-up ${offs})`);
          const top = await page.evaluate(() => { const e = document.querySelector('.key-white[data-note="62"]'); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y }; });
          await page.mouse.click(top.x, top.y + 4);
          const bottom = await page.evaluate(() => { const e = document.querySelector('.key-white[data-note="62"]'); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.bottom }; });
          await page.mouse.click(bottom.x, bottom.y - 3);
          const v62 = await page.evaluate(() => window.synthkit.app.sentMidi.filter((b) => b[0] === 0x90 && b[1] === 62).map((b) => b[2]));
          if (!(v62.length === 2 && v62[0] < 35 && v62[1] > 115)) fail(`top vs bottom of a key: ${v62}`); else pass(`keyboard: back of a key is soft, front is loud (${v62})`);
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

        // Tempo in patches (features.tempoInPatch): the BPM is saved with the
        // sound and marks it edited; a patch with a tempo sets the controls.
        const tp = await page.evaluate(() => {
          const app = window.synthkit.app, m = window.synthkit.model;
          app.bpm.value = "97"; app.bpm.dispatchEvent(new Event("change"));
          const saved = m.savePatch();
          const after = { bpm: saved.tempo && saved.tempo.bpm, dirty: m.dirty };
          m.loadPatch({ ...saved, tempo: { bpm: 133, timeSig: [3, 4] } });
          return { ...after, loadedBpm: app.transport.bpm, input: app.bpm.value, sig: app.sig.value };
        });
        if (tp.bpm !== 97 || !tp.dirty || tp.loadedBpm !== 133 || tp.input !== "133" || tp.sig !== "3/4") fail(`tempo in patches: ${JSON.stringify(tp)}`);
        else pass("the tempo is saved with the patch, and a patch's tempo sets the controls");

        // Messages (API.md §9b): the "Clear echoes" widget sends delay.clear,
        // and the synth's delay.cleared answer shows up in the widget.
        await page.locator(".ctl-custom button", { hasText: "Clear echoes" }).click();
        try {
          await page.waitForFunction(() => document.querySelector(".clear-note").textContent === "Cleared", null, { timeout: 3000 });
          pass("a message reaches the synth and its answer comes back");
        } catch { fail("Clear echoes: no delay.cleared message came back"); }
      }

      // The on-screen keyboard never keeps a key lit after it's let go: a
      // modifier pressed meanwhile, focus moved into a text field, a repeated
      // MIDI note-on, or a controller's all-notes-off.
      {
        const lit = () => page.$$eval(".key.is-down", (e) => e.length);
        const midi = (d) => page.evaluate((b) => window.synthkit.app.midi.message(new Uint8Array(b), performance.now()), d);
        const stuck = [];
        await page.keyboard.down("KeyA"); await page.keyboard.down("Control"); await page.keyboard.up("KeyA"); await page.keyboard.up("Control");
        if (await lit()) stuck.push("Ctrl"); await page.evaluate(() => window.synthkit.app.panic());
        await page.evaluate(() => { const i = document.createElement("input"); i.id = "sk-test-input"; document.body.append(i); });
        await page.keyboard.down("KeyS"); await page.focus("#sk-test-input"); await page.keyboard.up("KeyS");
        await page.evaluate(() => document.querySelector("#sk-test-input").remove());
        if (await lit()) stuck.push("text field"); await page.evaluate(() => window.synthkit.app.panic());
        await midi([0x90, 64, 100]); await midi([0x90, 64, 90]); await midi([0x80, 64, 0]);
        if (await lit()) stuck.push("repeated note-on"); await page.evaluate(() => window.synthkit.app.panic());
        await midi([0x91, 65, 100]); await midi([0xb1, 123, 0]);
        if (await lit()) stuck.push("CC 123");
        if (stuck.length) fail(`keyboard: keys stay lit after ${stuck.join(", ")}`);
        else pass("keyboard: no key stays lit (modifier, text field, repeated note-on, all notes off)");
      }

      // Pedals, mod wheel and knobs on the on-screen keyboard (API.md §9): the
      // pedal keys and buttons (with and without Latch), the wheel following
      // the scroll wheel, aftertouch and controller knobs, and all of them
      // following MIDI that comes in or being learned like a MIDI controller.
      {
        await page.evaluate(() => {
          const app = window.synthkit.app;
          if (!app.sentMidi) { app.sentMidi = []; const send = app.sendMidi.bind(app); app.sendMidi = (b, ...r) => { app.sentMidi.push([...b]); return send(b, ...r); }; }
          const e = document.querySelector(".kb-controls"); e.scrollIntoView({ block: "center" });
        });
        const sentCC = (cc) => page.evaluate((n) => window.synthkit.app.sentMidi.filter((b) => b[0] === 0xb0 && b[1] === n).map((b) => b[2]), cc);
        const clear = () => page.evaluate(() => { window.synthkit.app.sentMidi.length = 0; });
        const down = (name) => page.evaluate((n) => [...document.querySelectorAll(".pedal")].find((b) => b.textContent.startsWith(n)).getAttribute("aria-pressed") === "true", name);
        const midiIn = (...d) => page.evaluate((b) => window.synthkit.app.midi.message(new Uint8Array(b), performance.now()), d);
        const problems = [];

        // Held keys: down while held, up when let go.
        await clear();
        for (const [key, cc] of [["KeyM", 64], ["KeyN", 66], ["KeyB", 67]]) {
          await page.keyboard.down(key);
          const during = (await sentCC(cc)).slice(), lit = await down(cc === 64 ? "Sustain" : cc === 66 ? "Sostenuto" : "Soft");
          await page.keyboard.press("KeyA");   // a note meanwhile is unaffected
          await page.keyboard.up(key);
          const after = await sentCC(cc);
          if (during.join() !== "127" || !lit || after.join() !== "127,0") problems.push(`${key}: sent ${after}, lit ${lit}`);
        }
        // A key held through a blur lets go.
        await page.keyboard.down("KeyM"); await page.evaluate(() => window.dispatchEvent(new Event("blur")));
        if (await down("Sustain")) problems.push("a pedal key held through a window blur stays down");
        await page.keyboard.up("KeyM");
        // With a modifier it isn't a pedal.
        await clear(); await page.keyboard.down("Control"); await page.keyboard.press("KeyM"); await page.keyboard.up("Control");
        if ((await sentCC(64)).length) problems.push("Ctrl+M pressed the sustain pedal");
        if (problems.length) fail(`pedal keys: ${problems.join("; ")}`); else pass("pedal keys B, N, M hold the soft, sostenuto and sustain pedals");
        problems.length = 0;

        // The buttons, held with the mouse (momentary) and then latched.
        const sus = page.locator(".pedal", { hasText: "Sustain" });
        const box = await sus.boundingBox();
        await clear();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        if (!(await down("Sustain"))) problems.push("button: not down while held");
        await page.mouse.up();
        if (await down("Sustain") || (await sentCC(64)).join() !== "127,0") problems.push(`button: held, then ${await sentCC(64)}`);
        await page.locator(".kb-latch").click();
        await clear();
        await sus.click();
        const latchedDown = await down("Sustain");
        await page.keyboard.down("KeyM"); await page.keyboard.up("KeyM");   // the key toggles it back up
        const keyToggled = !(await down("Sustain"));
        await page.keyboard.down("KeyN"); await page.keyboard.up("KeyN");   // key down, key up: still down
        const keyLatched = await down("Sostenuto");
        await sus.click();                                                   // button down again
        if (!latchedDown || !keyToggled || !keyLatched || !(await down("Sustain"))) problems.push(`latch: button ${latchedDown}, key toggles ${keyToggled}, key latches ${keyLatched}`);
        if ((await sentCC(64)).join() !== "127,0,127") problems.push(`latch: sustain sent ${await sentCC(64)}`);
        await clear();
        await page.locator(".kb-latch").click();   // Latch off lets go of what it held
        if ((await down("Sustain")) || (await down("Sostenuto")) || (await sentCC(64)).join() !== "0" || (await sentCC(66)).join() !== "0") problems.push(`turning Latch off left a pedal down (sent ${await sentCC(64)}/${await sentCC(66)})`);
        if (problems.length) fail(`pedal buttons: ${problems.join("; ")}`); else pass("pedal buttons hold while pressed; Latch toggles them, and turning it off lets go");
        problems.length = 0;

        // Stop all sound lifts the pedals.
        await page.keyboard.down("KeyM"); await page.keyboard.down("KeyB");
        await clear(); await page.evaluate(() => window.synthkit.app.panic());
        if ((await down("Sustain")) || (await down("Soft")) || (await sentCC(64)).join() !== "0") problems.push("Stop all sound left a pedal down");
        await page.keyboard.up("KeyM"); await page.keyboard.up("KeyB");
        if (problems.length) fail(`pedals: ${problems.join("; ")}`); else pass("Stop all sound lifts the pedals");
        problems.length = 0;

        // The wheels, pedals and knobs follow MIDI coming in.
        const wheelNow = (label) => page.evaluate((l) => Number(document.querySelector(`[aria-label="${l}"]`).getAttribute("aria-valuenow")), label);
        await midiIn(0xb0, 64, 127); await midiIn(0xb0, 66, 127);
        if (!(await down("Sustain")) || !(await down("Sostenuto")) || (await down("Soft"))) problems.push("MIDI pedals don't light the buttons");
        await midiIn(0xb0, 123, 0);
        if ((await down("Sustain")) || (await down("Sostenuto"))) problems.push("all notes off leaves sustain/sostenuto lit");
        await midiIn(0xb0, 1, 127);
        if (Math.abs((await wheelNow("Mod wheel")) - 1) > 0.01) problems.push("MIDI mod wheel doesn't move the on-screen one");
        await midiIn(0xb0, 1, 0);
        await midiIn(0xe0, 127, 127);   // bend up fully
        if ((await wheelNow("Pitch bend")) < 0.99) problems.push("MIDI pitch bend doesn't move the on-screen wheel");
        await midiIn(0xe0, 0, 64);   // and back to the middle
        await midiIn(0xd0, 100, 0);
        if (await page.evaluate(() => document.querySelector(".kb-knob .kb-knob-value").textContent) !== "100") problems.push("MIDI aftertouch doesn't move the aftertouch knob");
        await midiIn(0xd0, 0, 0);
        if (problems.length) fail(`following MIDI: ${problems.join("; ")}`); else pass("wheels, pedals and the aftertouch knob follow MIDI coming in");
        problems.length = 0;

        // Scrolling over the mod wheel moves it (and not the page).
        const mw = await page.locator(".wheel-wrap", { hasText: "Mod" }).boundingBox();
        await clear();
        const y0 = await page.evaluate(() => window.scrollY);
        await page.mouse.move(mw.x + mw.width / 2, mw.y + mw.height / 2);
        await page.mouse.wheel(0, -300);
        const up = await wheelNow("Mod wheel");
        await page.mouse.wheel(0, 100);
        const back = await wheelNow("Mod wheel");
        const ccs = await sentCC(1);
        if (!(up > 0.1 && back < up && back > 0)) problems.push(`wheel values ${up}, ${back}`);
        if (!ccs.length || ccs.some((v, i) => i && v === ccs[i - 1])) problems.push(`CC 1 sent ${ccs}`);
        if ((await page.evaluate(() => window.scrollY)) !== y0) problems.push("the page scrolled");
        await page.mouse.wheel(0, 3000);
        if ((await wheelNow("Mod wheel")) !== 0) problems.push("scrolling down past the end doesn't stop at 0");
        if (problems.length) fail(`mod wheel scroll: ${problems.join("; ")}`); else pass(`scrolling over the mod wheel moves it (${up.toFixed(2)} up, ${back.toFixed(2)} after one notch down)`);
        problems.length = 0;

        // The knobs: aftertouch by default, then a controller, which the synth
        // maps like any other (CC 74 is the example synth's cutoff).
        await clear();
        const at = page.locator(".kb-knob").nth(0), cc = page.locator(".kb-knob").nth(1);
        await at.locator(".knob-dial").focus();
        for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowUp");
        const pressure = await page.evaluate(() => window.synthkit.app.sentMidi.filter((b) => b[0] === 0xd0).map((b) => b[1]));
        if (pressure.length !== 5 || pressure[4] !== 20) problems.push(`aftertouch knob sent ${pressure}`);
        await at.locator(".knob-dial").dblclick();   // double-click zeroes it
        if ((await page.evaluate(() => window.synthkit.app.sentMidi.filter((b) => b[0] === 0xd0).pop()[1])) !== 0) problems.push("double-click didn't zero the aftertouch knob");
        // Reassigning zeroes the old target first.
        await cc.locator(".knob-dial").focus(); await page.keyboard.press("ArrowUp");
        await clear();
        await cc.locator("select").selectOption("74");
        if ((await sentCC(11)).join() !== "0") problems.push(`reassigning left CC 11 at ${await sentCC(11)}`);
        const cutBefore = await page.evaluate(() => window.synthkit.model.get("filter.cutoff"));
        await cc.locator(".knob-dial").focus();
        for (let i = 0; i < 8; i++) await page.keyboard.press("PageUp");
        try { await page.waitForFunction((b) => Math.abs(window.synthkit.model.get("filter.cutoff") - b) > 1, cutBefore, { timeout: 3000 }); }
        catch { problems.push("a knob sending CC 74 didn't move the filter cutoff"); }
        if (await page.evaluate(() => JSON.parse(localStorage.getItem(`synthkit:${window.synthkit.model.info.synth.id}:keyboardKnobs`))[1]) !== 74) problems.push("the assignment isn't saved");
        if (problems.length) fail(`knobs: ${problems.join("; ")}`); else pass("knobs send aftertouch or any CC, zero on double-click and reassign, and drive the synth's mapped controllers");
        problems.length = 0;

        // MIDI learn without a controller: moving the on-screen knob is enough,
        // and the learned CC no longer reaches the synth.
        await page.evaluate(() => { const a = window.synthkit.app; a.midi.learn(a.controls.find((c) => c.p.id === "master" || c.p.id === "reverb.mix" || true)); });
        const learnId = await page.evaluate(() => window.synthkit.app.midi.learning);
        await clear();
        await cc.locator(".knob-dial").focus(); await page.keyboard.press("Home"); await page.keyboard.press("PageUp");
        const learned = await page.evaluate((id) => window.synthkit.app.midi.ccFor(id), learnId);
        if (learned !== 74) problems.push(`learn took CC ${learned}, wanted 74`);
        if ((await sentCC(74)).length) problems.push("the learned CC still reached the synth");
        const a = await page.evaluate((id) => window.synthkit.model.norm(id), learnId);
        for (let i = 0; i < 6; i++) await page.keyboard.press("PageUp");
        const b = await page.evaluate((id) => window.synthkit.model.norm(id), learnId);
        if (!(b > a)) problems.push(`the learned control didn't follow the knob (${a} -> ${b})`);
        await page.evaluate((id) => window.synthkit.app.midi.forget(id), learnId);
        if (problems.length) fail(`learning from a knob: ${problems.join("; ")}`); else pass("MIDI learn takes a move of an on-screen knob, and the control then follows it");
        problems.length = 0;
        // Back to the defaults for the tests that follow.
        await cc.locator("select").selectOption("11");
        await cc.locator(".knob-dial").dblclick();
        await page.evaluate(() => { localStorage.removeItem(`synthkit:${window.synthkit.model.info.synth.id}:keyboardKnobs`); });
      }

      // The arpeggiator's piano roll (API.md §4b): draw, move, lengthen,
      // set velocity and remove notes in pattern 2.
      if (await page.$(".arp-area")) {
        await page.evaluate(() => { window.synthkit.model.set("arp.pattern", 2); document.querySelector(".arp-area").scrollIntoView({ block: "center" }); });
        await page.waitForTimeout(100);
        const roll = await page.evaluate(() => {
          const m = window.synthkit.model, bank = m.custom("sk.arp");
          bank.patterns[1] = { steps: 16, notes: [] };
          m.setCustom("sk.arp", bank);
          return true;
        });
        const box = await page.locator(".arp-svg").boundingBox();
        // Same geometry as the editor: 30 px of row labels, rows 1–12 plus one below, 15 px each.
        const stepW = (box.width - 34) / 16, at = (st, row) => ({ x: box.x + 30 + (st + 0.5) * stepW, y: box.y + 2 + (11 - row + 0.5) * 15 });
        const notes = () => page.evaluate(() => window.synthkit.model.custom("sk.arp").patterns[1].notes);
        let a = at(2, 1), z = at(5, 1);
        await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(z.x, z.y, { steps: 4 }); await page.mouse.up();
        a = at(8, 3); await page.mouse.click(a.x, a.y);
        z = at(9, 5); await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(z.x, z.y, { steps: 4 }); await page.mouse.up();
        const drawn = JSON.stringify(await notes());
        if (!roll || drawn !== JSON.stringify([[2, 1, 4, 100], [9, 5, 1, 100]])) fail(`piano roll: drawing and moving gave ${drawn}`);
        else pass("piano roll: click-drag draws a long note, dragging moves one");
        await page.waitForTimeout(450);
        a = at(9, 5); await page.mouse.dblclick(a.x, a.y);
        const left = await notes();
        if (left.length !== 1) fail(`piano roll: double-click left ${JSON.stringify(left)}`); else pass("piano roll: double-click removes a note");
        // The generator: New idea draws a pattern, a slider redraws it, Undo restores.
        const pat2 = () => page.evaluate(() => JSON.stringify(window.synthkit.model.custom("sk.arp").patterns[1]));
        const before = await pat2();
        await page.locator(".arp-pattern-panel button", { hasText: "Generate…" }).click();
        await page.locator(".arp-gen button", { hasText: "New idea" }).click();
        const idea = await pat2();
        await page.$eval(".arp-gen input[aria-label=Density]", (e) => { e.value = 1; e.dispatchEvent(new Event("input")); });
        const busier = JSON.parse(await pat2()).notes.length;
        await page.locator(".arp-gen button", { hasText: "Undo" }).click();
        const undone = await pat2();
        if (idea === before || !(busier >= JSON.parse(idea).notes.length) || undone !== before) fail(`generator: idea changed ${idea !== before}, busier ${busier}, undo ${undone === before}`);
        else pass("generator: New idea draws a pattern, sliders redraw it, Undo restores");
        await page.evaluate(() => window.synthkit.model.set("arp.pattern", 1));
        // Sequencer: its own controls, interval rows, its own bank.
        const seqView = await page.evaluate(async () => {
          const m = window.synthkit.model;
          const shown = (id) => { const e = document.querySelector(`[data-param="${id}"]`); return !!e && !e.closest("[hidden]"); };
          m.set("arp.on", 2);
          await new Promise((r) => setTimeout(r, 50));
          const r = {
            controls: shown("arp.scale") && shown("arp.keyLevel") && !shown("arp.mode") && !shown("arp.octaves"),
            title: document.querySelector(".arp-pattern-panel .panel-title").textContent,
            key: [...document.querySelectorAll(".arp-row-label")].some((e) => e.textContent === "Key"),
            notes: document.querySelectorAll(".arp-note").length === m.custom("sk.seq").patterns[0].notes.length,
          };
          m.set("arp.on", 0);
          return r;
        });
        if (!seqView.controls || seqView.title !== "Sequencer pattern" || !seqView.key || !seqView.notes) fail(`sequencer view: ${JSON.stringify(seqView)}`);
        else pass("sequencer: its own controls, interval rows and pattern bank");
      }

      // Undo / redo (history.js) and the panels' reset buttons (reset.js).
      {
        const ev = (fn, arg) => page.evaluate(fn, arg);
        const get = (id) => ev((id) => window.synthkit.model.get(id), id);
        const cur = () => ev(() => ({ ...window.synthkit.app.presets.current, dirty: !!window.synthkit.model.dirty }));
        await ev(() => window.synthkit.app.presets.load(window.synthkit.app.presets.entries().find((e) => e.name === "Pluck")));
        const pluckCut = await get("filter.cutoff");
        // A drag is one step.
        const dial = page.locator('[data-param="filter.cutoff"] .knob-dial');
        await dial.scrollIntoViewIfNeeded();
        const db = await dial.boundingBox();
        await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2);
        await page.mouse.down();
        for (let i = 1; i <= 8; i++) await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2 - i * 6);
        await page.mouse.up();
        const dragged = await get("filter.cutoff");
        await page.waitForTimeout(800);
        await page.locator(".undo-btn").click();
        const afterUndo = await get("filter.cutoff"), c1 = await cur();
        if (!(dragged > pluckCut) || afterUndo !== pluckCut || c1.name !== "Pluck" || c1.dirty) fail(`undo a drag: ${pluckCut} → ${dragged} → ${afterUndo}, ${JSON.stringify(c1)}`);
        else pass("a knob drag undoes in one step, and the preset shows as unchanged again");
        await page.keyboard.press("Control+Shift+Z");
        if ((await get("filter.cutoff")) !== dragged) fail("Ctrl+Shift+Z didn't redo the drag"); else pass("Ctrl+Shift+Z redoes");
        // Picking a preset can be undone, label and all.
        await page.selectOption(".preset-select", { label: "Init" });
        await page.locator("main").click({ position: { x: 4, y: 4 } });
        await page.keyboard.press("Control+Z");
        const c2 = await cur();
        const near = (a, b) => Math.abs(a - b) <= 1e-4 * Math.max(1, Math.abs(b));   // patches store values as text
        if (!near(await get("filter.cutoff"), dragged) || c2.name !== "Pluck" || !c2.dirty) fail(`undoing a preset change: cutoff ${await get("filter.cutoff")}, ${JSON.stringify(c2)}`);
        else pass("undoing a preset change brings back the sound and its preset name");
        // Reset buttons: a click goes back to the saved preset (and only there);
        // right-click → Reset to defaults. One undo step each.
        const lfoDef = await ev(() => window.synthkit.model.param("lfo1.rate").def);
        await ev(() => { const m = window.synthkit.model; m.set("lfo1.rate", 5, "ui"); });
        await ev(() => window.synthkit.app.presets.store("Reset test"));
        await ev(() => { const m = window.synthkit.model; m.set("lfo1.rate", 9, "ui"); m.set("lfo1.depth", 0.25, "ui"); });
        const btn = page.locator(".lfo-panel .reset-btn").first();
        await page.click('.tab:text-is("LFOs")');
        await page.waitForTimeout(50);
        const t1 = await btn.getAttribute("title");
        await btn.click();
        const r1 = [await get("lfo1.rate"), await get("lfo1.depth")];
        await page.waitForTimeout(100);
        const idle = await btn.evaluate((b) => b.classList.contains("is-idle"));
        await btn.click({ force: true });   // (aria-disabled: Playwright would wait)
        const again = await get("lfo1.rate");
        await btn.click({ button: "right", force: true });
        await page.click('.menu-item:has-text("Reset to defaults")');
        const r2 = await get("lfo1.rate");
        await page.waitForTimeout(100);
        const t3 = await btn.getAttribute("title");
        const off = await page.locator(".lfo-panel .reset-btn").nth(1).evaluate((b) => b.classList.contains("is-idle"));   // LFO 2: untouched
        if (!/Reset test/.test(t1) || r1[0] !== 5 || r1[1] !== 1 || !idle || again !== 5 || Math.abs(r2 - lfoDef) > 1e-6 || !/Reset test/.test(t3) || !off)
          fail(`LFO reset: "${t1}" → ${r1}, idle ${idle}, clicked again → ${again}; right-click defaults → ${r2} (default ${lfoDef}), then "${t3}"; untouched LFO 2 idle: ${off}`);
        else pass("a panel's reset button always goes back to the saved preset; right-click resets to defaults");
        await page.keyboard.press("Control+Z");
        const u1 = await get("lfo1.rate");
        await page.keyboard.press("Control+Z");
        const u2 = [await get("lfo1.rate"), await get("lfo1.depth")];
        if (u1 !== 5 || u2[0] !== 9 || u2[1] !== 0.25) fail(`undoing resets gave ${u1}, then ${u2}`); else pass("each reset is one undo step");
        // A shape panel's reset covers its curve.
        const shapeBefore = await ev(() => JSON.stringify(window.synthkit.model.shapes()[0]));
        await ev(() => { const m = window.synthkit.model, s = m.shapes(); s[0] = { curves: [{ points: [[0, 0, 0, 0], [0.5, 1, 0, 0], [1, 0.2, 0, 0]] }] }; m.setShapes(s); });
        const shapeBtn = page.locator(".shape-panel .reset-btn").first();
        await page.click('.tab:text-is("Shapes")');
        await page.waitForTimeout(50);
        await shapeBtn.click();
        const shapeAfter = await ev(() => JSON.stringify(window.synthkit.model.shapes()[0]));
        if (shapeAfter !== shapeBefore) fail(`shape reset left ${shapeAfter} (saved ${shapeBefore})`); else pass("a shape panel's reset restores its curve");
        await ev(() => { window.synthkit.app.presets.remove(); });
      }

      // Preset categories (API.md §5): folders and "category", the picker,
      // stepping inside a category, saving into one and moving a preset. A
      // multi synth (API.md §5b) has no preset bar on the page (the sound bar
      // picks presets in their categories, multi-test.cjs, and a multi's voices
      // are its own), but the bar still keeps its presets: it's put on the
      // page for this, then taken off.
      {
        const ev = (fn, arg) => page.evaluate(fn, arg);
        const multiSynth = await ev(() => !!window.synthkit.app.sound);
        if (multiSynth) await ev(() => { const r = window.synthkit.app.presets.root; r.classList.add("test-presets"); document.querySelector("main").prepend(r); });
        const P = multiSynth ? ".test-presets " : ".presets ";
        const opts = (sel) => ev((sel) => [...document.querySelectorAll(sel + " option")].map((o) => o.textContent), sel);
        const cats = await opts(P + ".preset-category");
        const want = ["All", "Pads", "Leads", "Bass", "Keys", "Plucks", "Sequences", "Other"];
        if (JSON.stringify(cats) !== JSON.stringify(want)) fail(`category picker offers ${JSON.stringify(cats)}`);
        else pass("category picker: synth.json's order, a preset's own \"category\", and Other for the rest");
        await page.selectOption(P + ".preset-category", { label: "Pads" });
        const padList = (await opts(P + ".preset-select")).filter((t) => !/\(/.test(t));
        await page.click(P + 'button[title="Next preset"]');
        const a = await ev(() => window.synthkit.app.presets.current.name);
        await page.click(P + 'button[title="Next preset"]');
        const b = await ev(() => window.synthkit.app.presets.current.name);
        await page.click(P + 'button[title="Next preset"]');
        const c = await ev(() => window.synthkit.app.presets.current.name);
        const pads = ["Seq Breathing", "Warm Pad"];
        if (JSON.stringify(padList.sort()) !== JSON.stringify(pads) || !pads.includes(a) || !pads.includes(b) || a === b || c !== a)
          fail(`Pads: lists ${JSON.stringify(padList)}, steps ${a} → ${b} → ${c}`);
        else pass("picking a category lists only its presets, and ‹ › stay inside it");
        // A sound saved while Pads is picked goes into Pads (Init has no category).
        await ev(() => window.synthkit.app.presets.init());
        await ev(() => window.synthkit.app.presets.store("My Pad"));
        const saved = await ev(() => window.synthkit.app.presets.user["My Pad"].category);
        const listed = await opts(P + ".preset-select");
        if (saved !== "Pads" || !listed.includes("My Pad")) fail(`saving under Pads: category ${saved}, list ${JSON.stringify(listed)}`);
        else pass("a new preset saved while a category is picked goes into it");
        // Category… moves one of your presets, and the picker follows.
        await page.click(P + 'button[title="More preset actions"]');
        await page.click('.menu-item:text-is("Category…")');
        await page.click('.menu-item:text-is("Leads")');
        const moved = await ev(() => ({ cat: window.synthkit.app.presets.user["My Pad"].category, filter: window.synthkit.app.presets.category,
                                        sound: window.synthkit.model.patchCategory, dirty: !!window.synthkit.model.dirty }));
        if (moved.cat !== "Leads" || moved.filter !== "Leads" || moved.sound !== "Leads" || moved.dirty) fail(`moving to Leads: ${JSON.stringify(moved)}`);
        else pass("Category… moves one of your presets to another category");
        // A factory copy saved keeps its folder's category.
        await page.selectOption(P + ".preset-category", { label: "All" });
        await ev(() => window.synthkit.app.presets.load(window.synthkit.app.presets.entries().find((e) => e.name === "Mono Bass")));
        await ev(() => window.synthkit.app.presets.store("Bass copy"));
        const copyCat = await ev(() => window.synthkit.app.presets.user["Bass copy"].category);
        const groups = await ev(() => [...document.querySelectorAll(".presets:not(.sound) .preset-select optgroup")].map((g) => g.label));   // (.test-presets is one)
        if (copyCat !== "Bass" || !groups.includes("Bass · yours") || !groups.includes("Leads · yours")) fail(`copy of Mono Bass: ${copyCat}, groups ${JSON.stringify(groups)}`);
        else pass("a copy of a factory preset keeps its folder's category; All groups by category");
        for (const n of ["My Pad", "Bass copy"]) await ev((n) => { const p = window.synthkit.app.presets; p.load(p.entries().find((e) => e.name === n && e.kind === "user")); p.remove(); }, n);
        await page.selectOption(P + ".preset-category", { label: "All" });
        if (multiSynth) await ev(() => window.synthkit.app.presets.root.remove());
      }

      // Diagnostics (API.md §10a). A key whose release never arrives (sent
      // straight to the engine, as from a DAW), then the same key pressed
      // again on the page: one voice, and letting go ends it (§4). With
      // diagnostics on, Stop all sound then shows a report with the re-press.
      {
        const app = () => window.synthkit.app;
        // Poly with a short release (earlier steps may have left a mono or pad preset).
        await page.evaluate(() => { const m = window.synthkit.model; m.set("voiceMode", 0); m.set("env1.release", 0.05); m.set("unison", 1); });
        await page.waitForTimeout(100);
        await page.evaluate(() => { const a = window.synthkit.app; a.panic(); a.sendMidi([0x90, 62, 100]); });   // its note-off is lost
        await page.waitForTimeout(400);
        await page.evaluate(() => window.synthkit.app.noteOn(62, 100));
        await page.waitForTimeout(400);
        const held = await page.evaluate(() => window.synthkit.app.lastVoices);
        await page.evaluate(() => window.synthkit.app.noteOff(62));
        await page.waitForTimeout(1500);
        const after = await page.evaluate(() => window.synthkit.app.lastVoices);
        if (held !== 1 || after !== 0) fail(`a key pressed again after a lost release: ${held} voice(s) while held, ${after} after letting go (want 1, 0)`);
        else pass("a key pressed again after its release was lost: one voice, and letting go ends it");
        await page.click(".diag-btn");
        await page.click('.menu-item:text-is("Diagnostics off")');
        const on = await page.evaluate(() => window.synthkit.app.diag.on);
        await page.evaluate(() => { const a = window.synthkit.app; a.noteOn(64, 90); a.noteOff(64); });
        await page.click('.panic-group > .btn:first-child');   // Stop all sound
        await page.waitForSelector(".diag-pop .diag-text", { timeout: 3000 }).catch(() => {});
        const text = await page.evaluate(() => (document.querySelector(".diag-pop .diag-text") || {}).value || "");
        let rep = null;
        try { rep = JSON.parse(text); } catch (e) {}
        const parts = rep && rep.engine && rep.engine.parts;
        const router = rep && rep.engine && rep.engine.router;   // a Multi deals with re-presses before its parts
        const represses = parts ? parts[0].counts.represses + (router ? router.represses : 0) : 0;
        const kinds = parts ? parts[0].events.map((e) => e[1]).concat(router ? router.events.map((e) => e[1]) : []) : [];
        const fromScreen = rep ? rep.pageMidi.filter((e) => e[1] === "screen keys").length : 0;
        if (!on || !rep || rep.trigger !== "Stop all sound" || !parts || represses < 1 || !kinds.includes("repress") ||
            !kinds.includes("panic") || fromScreen < 4 || !Array.isArray(rep.keysLit))
          fail(`diagnostics report on Stop all sound: on ${on}, ${rep ? JSON.stringify({ trigger: rep.trigger, counts: parts && parts[0].counts, kinds: kinds.slice(-6), fromScreen }) : "no report: " + text.slice(0, 120)}`);
        else pass(`Stop all sound with diagnostics on: a report with the re-press (${represses}), panic, ${fromScreen} page notes`);
        await page.click('.diag-pop .btn:text-is("Close")');
        await page.click(".diag-btn");
        await page.click('.menu-item:has-text("Diagnostics on")');   // back off
        await page.click(".diag-btn");
        await page.click('.menu-item:text-is("Make a diagnostics report")');
        await page.waitForSelector(".diag-pop .diag-text", { timeout: 3000 }).catch(() => {});
        const onDemand = await page.evaluate(() => ({ off: !window.synthkit.app.diag.on, open: !!document.querySelector(".diag-pop"), stored: localStorage.getItem("synthkit:diagnostics") }));
        await page.screenshot({ path: path.join(outDir, "ui-diagnostics.png") });
        if (!onDemand.off || !onDemand.open) fail(`diagnostics off, report on demand: ${JSON.stringify(onDemand)}`);
        else pass("diagnostics off again; a report on demand from the menu");
        await page.keyboard.press("Escape");
        if (await page.evaluate(() => !!document.querySelector(".diag-pop"))) fail("Escape doesn't close the diagnostics report");
      }
      }  // kitUi
    }
    if (errors.length) fail(`${name}: console errors: ${errors.join(" | ")}`); else pass(`${name}: boots with no console errors`);
    await page.close();
  }

  // Playing it the way a person does, in a browser as it really behaves:
  // sound may only start during a click or key press (headless Chromium
  // doesn't enforce that, so it's emulated, waiting resume() included), and a
  // MIDI keyboard arrives through Web MIDI (a fake one). Every synth's page,
  // the kit's or its own, must start on the first click, offer Connect MIDI,
  // play MIDI notes and follow its mapped controllers (API.md §3, §9a).
  {
    const strict = await chromium.launch();
    const page = await strict.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.addInitScript(() => {
      const Orig = window.AudioContext, realResume = Orig.prototype.resume;
      window.AudioContext = class extends Orig {
        constructor(...a) { super(...a); this.__waiting = []; if (!navigator.userActivation.isActive) this.suspend(); }
        resume() {
          if (!navigator.userActivation.isActive) return new Promise((r) => this.__waiting.push(r));
          return realResume.call(this).then(() => { this.__waiting.splice(0).forEach((r) => r()); });
        }
      };
      const input = { id: "test", name: "Test keyboard", state: "connected", type: "input", onmidimessage: null };
      window.__midi = (...d) => input.onmidimessage && input.onmidimessage({ data: new Uint8Array(d), timeStamp: performance.now() });
      navigator.requestMIDIAccess = async () => ({ inputs: new Map([["test", input]]), outputs: new Map(), onstatechange: null });
      // Something tries to start the sound as the page loads, before any
      // click (as a page sending a message from mount() would). It runs from
      // the page's own timer: Playwright's evaluate() counts as a click.
      const early = setInterval(() => { if (window.synthkit && window.synthkit.app) { clearInterval(early); window.synthkit.app.startAudio(); } }, 20);
    });
    // Only plain waits until the click: Playwright's evaluate() and
    // waitForFunction() count as user gestures, which would let the early
    // attempt start the sound by itself.
    await page.goto(url);
    // The early attempt (above) left the sound suspended; the first click
    // must still start it. (Wait until that attempt is set up and waiting on
    // resume(): a browser counts a click as recent for a few seconds.)
    await page.waitForTimeout(3000);
    await page.mouse.click(5, 5);
    try {
      await page.waitForFunction(() => window.synthkit.app.audio.running, null, { timeout: 5000 });
      pass("strict autoplay: the first click starts the sound, even after an attempt before it");
    } catch { fail("strict autoplay: a click didn't start the sound after an early attempt (it stays suspended)"); }
    // Connect MIDI must be on the page.
    const midiBtn = page.locator(".midi button", { hasText: "Connect MIDI" }).first();
    if (!(await midiBtn.count()) || !(await midiBtn.isVisible())) fail("there's no Connect MIDI button on the page");
    else {
      await midiBtn.click();
      await page.waitForTimeout(300);
      await page.evaluate(() => window.__midi(0x90, 60, 100));
      await page.waitForTimeout(500);
      const voices = await page.evaluate(() => window.synthkit.app.voices.textContent);
      if (!/^[1-9]/.test(voices)) fail(`a MIDI keyboard's note didn't start a voice ("${voices}")`); else pass(`a MIDI keyboard plays (${voices})`);
      await page.evaluate(() => window.__midi(0x80, 60, 0));
      // Mapped controllers (ParamDef::cc) move their parameter, and the page follows.
      const mapped = await page.evaluate(() => window.synthkit.model.params.filter((p) => p.controllers).map((p) => ({ id: p.id, ...p.controllers[0] })));
      for (const c of mapped.slice(0, 3)) {
        const before = await page.evaluate((id) => window.synthkit.model.get(id), c.id);
        const value = Math.abs(before - c.hi) > Math.abs(before - c.lo) ? 127 : 0;
        const target = value ? c.hi : c.lo;
        await page.evaluate(([cc, v]) => window.__midi(0xb0, cc, v), [c.cc, value]);
        try {
          await page.waitForFunction(([id, t]) => Math.abs(window.synthkit.model.get(id) - t) <= Math.abs(t) * 1e-3 + 1e-6, [c.id, target], { timeout: 3000 });
          pass(`CC ${c.cc} moves ${c.id}, and the page follows`);
        } catch { fail(`CC ${c.cc} didn't move ${c.id} (still ${await page.evaluate((id) => window.synthkit.model.get(id), c.id)}, wanted ${target})`); }
      }
    }
    if (errors.length) fail(`strict autoplay: console errors: ${errors.join(" | ")}`);
    await strict.close();
  }

  // Dark is the default theme; also check the light one (chosen from the header).
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(url);
    await page.waitForFunction(() => window.synthkit && window.synthkit.model);
    const dflt = await page.evaluate(() => document.documentElement.dataset.theme);
    if (dflt !== "dark") fail(`default theme is ${dflt}, not dark`); else pass("the page starts in the dark theme");
    await page.evaluate(() => localStorage.setItem("synthkit:theme", JSON.stringify("light")));
    await page.reload();
    await page.waitForFunction(() => window.synthkit && window.synthkit.model);
    await page.waitForTimeout(200);
    const chosen = await page.evaluate(() => document.documentElement.dataset.theme);
    if (chosen !== "light") fail(`choosing light gave ${chosen}`);
    await page.screenshot({ path: path.join(outDir, "ui-light.png"), fullPage: true });
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
      // The scenario's tempo, else the patch's (features.tempoInPatch), else
      // 120, as the native render tool does.
      const pt = sk.model.info.synth.tempoInPatch ? sk.model.patchTempo() : null;
      const bpm = (sc.transport || {}).bpm || (pt && pt.bpm) || 120;
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
        transport: { bpm, playing: !!tr.playing, num: (tr.timeSig || [pt ? pt.num : 4])[0], den: (tr.timeSig || [4, pt ? pt.den : 4])[1] } });
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
