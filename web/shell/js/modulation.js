// Modulation UI: LFO panels, shape editors, the matrix, and the live
// meters that drive knob rings, LFO meters and shape playheads.

// ---- meters -------------------------------------------------------------------

class ModMeters {
  constructor(model) {
    this.model = model;
    this.ns = model.mod.sources.length;
    this.np = model.params.length;
    this.data = null;
    this.subs = new Set();
  }
  update(arr) {
    if (!arr || !arr.length) return;
    this.data = arr;
    for (const fn of this.subs) fn(this);
  }
  on(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  source(i) { return this.data ? this.data[i] : 0; }
  sourceById(id) { const i = this.model.sourceIndex.get(id); return i === undefined ? 0 : this.source(i); }
  param(i) { return this.data ? this.data[this.ns + i] : NaN; }
  shape(n) {  // n is 0-based
    if (!this.data) return { phase: -1, value: 0 };
    const k = this.ns + this.np + n * 2;
    return { phase: this.data[k], value: this.data[k + 1] };
  }
}

// ---- helpers -------------------------------------------------------------------

function skDivisionBeats(name, transport) {
  const bars = /^(\d+)\s*bars?$/.exec(name);
  if (bars) return Number(bars[1]) * transport.num * (4 / transport.den);
  const m = /^(\d+)\/(\d+)([T.]?)$/.exec(name);
  if (!m) return 1;
  let b = (4 * Number(m[1])) / Number(m[2]);
  if (m[3] === "T") b *= 2 / 3;
  if (m[3] === ".") b *= 1.5;
  return b;
}

function skSection(title, cls) {
  const controls = h("div", { class: "controls" });
  const root = h("section", { class: "panel " + (cls || "") }, h("h2", { class: "panel-title", text: title }));
  return { root, controls };
}

function skAddControls(app, target, specs) {
  const out = {};
  for (const [id, label, type] of specs) {
    const p = app.model.param(id);
    if (!p) continue;
    const ctl = makeControl(app, p, { label, type });
    app.controls.push(ctl);
    target.append(ctl.root);
    out[id] = ctl;
  }
  return out;
}

// ---- LFO panel --------------------------------------------------------------------

class LfoPanel {
  constructor(app, n) {
    const m = app.model, pre = `lfo${n}.`;
    const { root, controls } = skSection(`LFO ${n}`, "lfo-panel");
    this.preview = svg("svg", { class: "lfo-preview", viewBox: "0 0 120 40", preserveAspectRatio: "none", "aria-hidden": "true" });
    this.line = svg("path", { class: "lfo-line" });
    this.dot = svg("circle", { class: "lfo-dot", r: 3.2, cx: 116, cy: 20 });
    this.preview.append(svg("line", { class: "lfo-axis", x1: 0, x2: 120, y1: 20, y2: 20 }), this.line, this.dot);
    root.append(this.preview, controls);
    const c = skAddControls(app, controls, [
      [pre + "shape", "Shape", "menu"], [pre + "sync", "Sync", "toggle"], [pre + "rate", "Rate"], [pre + "division", "Division", "menu"],
      [pre + "mode", "Mode", "segmented"], [pre + "phase", "Phase"], [pre + "depth", "Depth"], [pre + "fade", "Fade in"]]);
    m.on(pre + "sync", (v) => {
      if (c[pre + "rate"]) c[pre + "rate"].root.hidden = v >= 0.5;
      if (c[pre + "division"]) c[pre + "division"].root.hidden = v < 0.5;
    });
    m.on(pre + "shape", () => this.draw());
    m.on(pre + "phase", () => this.draw());
    this.m = m; this.pre = pre;
    const syncOn = m.get(pre + "sync") >= 0.5;
    c[pre + "rate"].root.hidden = syncOn;
    c[pre + "division"].root.hidden = !syncOn;
    this.draw();
    this.src = m.sourceIndex.get(`lfo${n}`);
    app.modMeters.on((mm) => {
      const v = mm.source(this.src);
      this.dot.setAttribute("cy", (20 - Math.max(-1, Math.min(1, v)) * 17).toFixed(1));
    });
    this.root = root;
  }
  draw() {
    const shape = Math.round(this.m.get(this.pre + "shape"));
    const ph = this.m.get(this.pre + "phase");
    let held = [0.6, -0.4, 0.9, -0.8, 0.2, 0.7];
    const f = (p) => {
      const q = (p + ph) % 1;
      switch (shape) {
        case 0: return Math.sin(2 * Math.PI * q);
        case 1: return 1 - 4 * Math.abs(((q + 0.25) % 1) - 0.5);
        case 2: return 2 * q - 1;
        case 3: return 1 - 2 * q;
        case 4: return q < 0.5 ? 1 : -1;
        case 5: return held[Math.floor(p * 3) % held.length];
        default: { const i = Math.floor(p * 3), t = p * 3 - i, w = 0.5 - 0.5 * Math.cos(Math.PI * t); return held[i] + (held[i + 1] - held[i]) * w; }
      }
    };
    let d = "";
    for (let i = 0; i <= 108; i++) d += (i ? "L" : "M") + (2 + i).toFixed(1) + " " + (20 - f(i / 108) * 17).toFixed(1) + " ";
    this.line.setAttribute("d", d);
  }
}

// ---- shape editor -----------------------------------------------------------------

const SK_SHAPE_PRESETS = [
  ["Ramp down", [[0, 1, -0.5, 0], [1, 0, 0, 0]]],
  ["Ramp up", [[0, 0, 0.5, 0], [1, 1, 0, 0]]],
  ["Pump", [[0, 0.15, -0.4, 0], [0.1, 1, 0.5, 0], [0.5, 0.3, -0.3, 0], [0.6, 1, 0.5, 0], [1, 0.15, 0, 0]]],
  ["Swell", [[0, 0, 0.6, 0], [0.7, 1, -0.3, 0], [1, 0.6, 0, 0]]],
  ["Triangle", [[0, 0, 0, 0], [0.5, 1, 0, 0], [1, 0, 0, 0]]],
  ["Square", [[0, 1, 0, 1], [0.5, 0, 0, 1], [1, 0, 0, 0]]],
];

function skEvalCurve(pts, x) {
  if (!pts.length) return 0;
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x0, y0, c, hold] = pts[i], [x1, y1] = pts[i + 1];
    if (x > x1) continue;
    if (hold) return y0;
    if (x1 - x0 < 1e-6) return y1;
    let t = (x - x0) / (x1 - x0);
    if (c) t = Math.pow(t, Math.pow(2, 3 * c));
    return y0 + (y1 - y0) * t;
  }
  return pts[pts.length - 1][1];
}

class ShapeEditor {
  constructor(app, n) {
    this.app = app; this.m = app.model; this.n = n; this.pre = `shape${n}.`;
    this.tool = "points";
    this.snap = true;
    this.sel = -1;
    this.W = 600; this.H = 170; this.pad = 10;
    this.svg = svg("svg", { class: "shape-svg", "aria-hidden": "true" });
    this.g = { grid: svg("g"), fill: svg("path", { class: "shape-fill" }), line: svg("path", { class: "shape-line" }),
      rel: svg("g", { class: "shape-release" }), handles: svg("g"), points: svg("g"), head: svg("line", { class: "shape-head" }) };
    this.svg.append(this.g.grid, this.g.fill, this.g.line, this.g.rel, this.g.handles, this.g.points, this.g.head);
    this.area = h("div", { class: "shape-area", tabindex: 0, role: "application",
      "aria-label": `Shape ${n} curve editor. Arrow keys move the selected point, comma and period select points, Delete removes, H toggles a step.` }, this.svg);
    const toolSeg = h("div", { class: "seg seg-small", role: "radiogroup", "aria-label": "Editing tool" });
    this.toolBtns = ["points", "steps"].map((t) => h("button", { type: "button", class: "seg-btn", role: "radio", text: t === "points" ? "Points" : "Steps", onclick: () => this.setTool(t) }));
    toolSeg.append(...this.toolBtns);
    this.snapBtn = h("button", { type: "button", class: "btn btn-small", "aria-pressed": "true", title: "Snap to the beat grid (hold Shift to place freely)", onclick: () => { this.snap = !this.snap; this.snapBtn.setAttribute("aria-pressed", String(this.snap)); } }, "Snap");
    const presets = h("button", { type: "button", class: "btn btn-small btn-quiet", onclick: (e) => this.presetMenu(e) }, "Curves…");
    this.hint = h("span", { class: "shape-hint" });
    this.bar = h("div", { class: "shape-bar" }, toolSeg, this.snapBtn, presets, this.hint);
    this.root = h("div", { class: "shape-editor" }, this.bar, this.area);
    this.setTool("points");

    this.load();
    this.m.onShapes(() => { this.load(); this.draw(); });
    for (const id of ["curve", "loop", "length", "sync"]) this.m.on(this.pre + id, () => { this.load(); this.draw(); });
    this.app.onTransport(() => this.draw());
    new ResizeObserver(() => this.resize()).observe(this.area);
    this.app.modMeters.on((mm) => this.playhead(mm.shape(n - 1)));
    this.bindPointer();
    this.bindKeys();
  }

  setTool(t) {
    this.tool = t;
    this.toolBtns.forEach((b, i) => b.setAttribute("aria-checked", String(["points", "steps"][i] === t)));
    this.hint.textContent = t === "points"
      ? "Drag points. Double-click to add or remove one, drag a diamond to bend, right-click a point to make a step."
      : "Click or drag to set each step's level.";
  }

  // Data ---------------------------------------------------------------------------
  curveIndex() { return Math.max(0, Math.round(this.m.get(this.pre + "curve")) - 1); }
  load() {
    this.all = this.m.shapes();
    const s = this.all[this.n - 1] || (this.all[this.n - 1] = { curves: [] });
    while (s.curves.length <= this.curveIndex()) s.curves.push({ points: [[0, 1, -0.5, 0], [1, 0, 0, 0]] });
    this.curve = s.curves[this.curveIndex()];
    if (this.sel >= this.curve.points.length) this.sel = -1;
  }
  commit() {
    // Keep points ordered and the ends pinned to 0 and 1.
    const p = this.curve.points;
    p.sort((a, b) => a[0] - b[0]);
    p[0][0] = 0;
    p[p.length - 1][0] = 1;
    this.m.setShapes(this.all, true);
    this.draw();
  }
  lengthBeats() {
    if (this.m.get(this.pre + "sync") < 0.5) return 0;
    const p = this.m.param(this.pre + "length");
    return skDivisionBeats(p.choices[Math.round(this.m.get(p.index))], this.app.transport);
  }
  snapStep() {
    const beats = this.lengthBeats();
    if (!beats) return 1 / 16;
    const unit = 0.25;  // sixteenth notes
    return Math.max(1 / 64, unit / beats);
  }

  // Geometry -------------------------------------------------------------------------
  resize() {
    const w = Math.max(240, Math.round(this.area.clientWidth));
    this.W = w;
    this.H = w < 480 ? 140 : 170;
    this.svg.setAttribute("viewBox", `0 0 ${this.W} ${this.H}`);
    this.svg.setAttribute("width", this.W);
    this.svg.setAttribute("height", this.H);
    this.draw();
  }
  px(x) { return this.pad + x * (this.W - 2 * this.pad); }
  py(y) { return this.pad + (1 - y) * (this.H - 2 * this.pad); }
  fromEvent(e) {
    const r = this.svg.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width * this.W - this.pad) / (this.W - 2 * this.pad);
    const y = 1 - ((e.clientY - r.top) / r.height * this.H - this.pad) / (this.H - 2 * this.pad);
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  }
  snapX(x, e) {
    if (!this.snap || (e && e.shiftKey)) return x;
    const s = this.snapStep();
    return Math.round(x / s) * s;
  }

  // Drawing ----------------------------------------------------------------------------
  draw() {
    if (!this.curve) return;
    const { grid } = this.g;
    grid.textContent = "";
    const beats = this.lengthBeats();
    const t = this.app.transport;
    const lines = [];
    if (beats) {
      const beatUnit = 4 / t.den, barLen = t.num * beatUnit;
      const sub = 0.25;
      for (let b = 0; b <= beats + 1e-9; b += sub) {
        const x = b / beats;
        const kind = Math.abs(b / barLen - Math.round(b / barLen)) < 1e-9 ? "bar" : Math.abs(b / beatUnit - Math.round(b / beatUnit)) < 1e-9 ? "beat" : "sub";
        lines.push([x, kind]);
      }
      if (lines.filter((l) => l[1] === "sub").length > 64) for (const l of lines) if (l[1] === "sub") l[1] = "";
    } else {
      for (let i = 0; i <= 16; i++) lines.push([i / 16, i % 4 === 0 ? "beat" : "sub"]);
    }
    for (const [x, kind] of lines) {
      if (!kind) continue;
      grid.append(svg("line", { class: "grid-" + kind, x1: this.px(x), x2: this.px(x), y1: this.pad, y2: this.H - this.pad }));
    }
    for (const y of [0, 0.5, 1]) grid.append(svg("line", { class: y === 0.5 ? "grid-sub" : "grid-beat", x1: this.pad, x2: this.W - this.pad, y1: this.py(y), y2: this.py(y) }));

    const pts = this.curve.points;
    let d = "";
    const steps = Math.max(80, Math.round(this.W / 3));
    for (let i = 0; i <= steps; i++) {
      const x = i / steps;
      d += (i ? "L" : "M") + this.px(x).toFixed(1) + " " + this.py(skEvalCurve(pts, x)).toFixed(1) + " ";
    }
    this.g.line.setAttribute("d", d);
    this.g.fill.setAttribute("d", d + `L ${this.px(1)} ${this.py(0)} L ${this.px(0)} ${this.py(0)} Z`);

    this.g.points.textContent = "";
    this.g.handles.textContent = "";
    if (this.tool === "points") {
      pts.forEach((p, i) => {
        if (i + 1 < pts.length && !p[3] && pts[i + 1][0] - p[0] > 0.02) {
          const mx = (p[0] + pts[i + 1][0]) / 2;
          const hy = this.py(skEvalCurve(pts, mx));
          this.g.handles.append(svg("rect", { class: "shape-handle", "data-seg": i, x: this.px(mx) - 4, y: hy - 4, width: 8, height: 8, transform: `rotate(45 ${this.px(mx)} ${hy})` }));
        }
        this.g.points.append(svg("circle", { class: "shape-point" + (p[3] ? " is-step" : "") + (i === this.sel ? " is-sel" : ""), "data-pt": i, cx: this.px(p[0]), cy: this.py(p[1]), r: i === this.sel ? 6 : 5 }));
      });
    }

    this.g.rel.textContent = "";
    if (Math.round(this.m.get(this.pre + "loop")) === 4) {
      const rx = this.px(this.curve.release >= 0 ? this.curve.release : 1);
      this.g.rel.append(svg("line", { x1: rx, x2: rx, y1: this.pad, y2: this.H - this.pad }),
        svg("rect", { class: "release-grip", "data-rel": 1, x: rx - 6, y: 0, width: 12, height: 12, rx: 2 }));
    }
  }

  playhead(s) {
    if (!s || s.phase < 0) { this.g.head.setAttribute("visibility", "hidden"); return; }
    const x = this.px(s.phase);
    this.g.head.setAttribute("visibility", "visible");
    this.g.head.setAttribute("x1", x); this.g.head.setAttribute("x2", x);
    this.g.head.setAttribute("y1", this.pad); this.g.head.setAttribute("y2", this.H - this.pad);
  }

  // Editing ---------------------------------------------------------------------------
  bindPointer() {
    let drag = null;
    this.svg.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      this.area.focus({ preventScroll: true });
      const t = e.target;
      const pts = this.curve.points;
      this.svg.setPointerCapture(e.pointerId);
      if (t.dataset && t.dataset.rel) { drag = { kind: "rel" }; return; }
      if (this.tool === "steps") { drag = { kind: "steps" }; this.paintStep(e); return; }
      if (t.dataset && t.dataset.pt !== undefined) { this.sel = Number(t.dataset.pt); drag = { kind: "pt", i: this.sel }; this.draw(); return; }
      if (t.dataset && t.dataset.seg !== undefined) { const i = Number(t.dataset.seg); drag = { kind: "bend", i, y: e.clientY, c: pts[i][2] }; return; }
      this.sel = -1;
      this.draw();
    });
    this.svg.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const pts = this.curve.points;
      const { x, y } = this.fromEvent(e);
      if (drag.kind === "pt") {
        const i = drag.i;
        const lo = i === 0 ? 0 : pts[i - 1][0], hi = i === pts.length - 1 ? 1 : pts[i + 1][0];
        if (i !== 0 && i !== pts.length - 1) pts[i][0] = Math.min(hi, Math.max(lo, this.snapX(x, e)));
        pts[i][1] = y;
      } else if (drag.kind === "bend") {
        const up = pts[drag.i + 1][1] >= pts[drag.i][1];
        const d = (drag.y - e.clientY) / 80;
        pts[drag.i][2] = Math.max(-1, Math.min(1, drag.c + (up ? -d : d)));
      } else if (drag.kind === "steps") {
        this.paintStep(e);
        return;
      } else if (drag.kind === "rel") {
        this.curve.release = Math.min(1, Math.max(0, this.snapX(x, e)));
      }
      this.commit();
    });
    const end = () => { drag = null; };
    this.svg.addEventListener("pointerup", end);
    this.svg.addEventListener("pointercancel", end);
    this.svg.addEventListener("dblclick", (e) => {
      if (this.tool !== "points") return;
      const t = e.target, pts = this.curve.points;
      if (t.dataset && t.dataset.pt !== undefined) {
        const i = Number(t.dataset.pt);
        if (i > 0 && i < pts.length - 1) { pts.splice(i, 1); this.sel = -1; this.commit(); }
        return;
      }
      if (pts.length >= 64) { this.app.toast("A curve can have up to 64 points."); return; }
      const { x, y } = this.fromEvent(e);
      const sx = this.snapX(x, e);
      if (sx <= 0 || sx >= 1) return;
      pts.push([sx, y, 0, 0]);
      pts.sort((a, b) => a[0] - b[0]);
      this.sel = pts.findIndex((p) => p[0] === sx && p[1] === y);
      this.commit();
    });
    this.svg.addEventListener("contextmenu", (e) => {
      const t = e.target;
      if (t.dataset && t.dataset.pt !== undefined) {
        e.preventDefault();
        const p = this.curve.points[Number(t.dataset.pt)];
        p[3] = p[3] ? 0 : 1;
        this.commit();
      }
    });
  }

  // Steps tool: cells on the snap grid, each a flat step.
  paintStep(e) {
    const { x, y } = this.fromEvent(e);
    const step = this.snapStep();
    const cells = Math.round(1 / step);
    const pts = this.curve.points;
    const isSteps = pts.length === cells + 1 && pts.slice(0, -1).every((p, i) => p[3] && Math.abs(p[0] - i * step) < 1e-6);
    const levels = isSteps ? pts.slice(0, -1).map((p) => p[1]) : [...Array(cells).keys()].map((i) => skEvalCurve(pts, (i + 0.5) * step));
    const c = Math.min(cells - 1, Math.floor(x / step));
    levels[c] = Math.round(y * 20) / 20;
    this.curve.points = levels.map((v, i) => [i * step, v, 0, 1]).concat([[1, levels[cells - 1], 0, 0]]);
    this.sel = -1;
    this.commit();
  }

  bindKeys() {
    this.area.addEventListener("keydown", (e) => {
      const pts = this.curve.points;
      if (e.key === "," || e.key === ".") {
        this.sel = this.sel < 0 ? 0 : (this.sel + (e.key === "." ? 1 : -1) + pts.length) % pts.length;
        e.preventDefault(); e.stopPropagation(); this.draw(); return;
      }
      if (this.sel < 0) return;
      const p = pts[this.sel], fine = e.shiftKey;
      const dx = fine ? 0.005 : this.snapStep(), dy = fine ? 0.01 : 0.05;
      let used = true;
      if (e.key === "ArrowUp") p[1] = Math.min(1, p[1] + dy);
      else if (e.key === "ArrowDown") p[1] = Math.max(0, p[1] - dy);
      else if (e.key === "ArrowLeft" && this.sel > 0 && this.sel < pts.length - 1) p[0] = Math.max(pts[this.sel - 1][0], p[0] - dx);
      else if (e.key === "ArrowRight" && this.sel > 0 && this.sel < pts.length - 1) p[0] = Math.min(pts[this.sel + 1][0], p[0] + dx);
      else if ((e.key === "Delete" || e.key === "Backspace") && this.sel > 0 && this.sel < pts.length - 1) { pts.splice(this.sel, 1); this.sel = -1; }
      else if (e.key === "h" || e.key === "H") p[3] = p[3] ? 0 : 1;
      else used = false;
      if (used) { e.preventDefault(); e.stopPropagation(); this.commit(); }
    });
  }

  presetMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    const set = (pts) => { this.curve.points = pts.map((p) => p.slice()); this.sel = -1; this.commit(); };
    this.app.menu(r.left, r.bottom + 4, [
      ...SK_SHAPE_PRESETS.map(([name, pts]) => ({ label: name, run: () => set(pts) })),
      null,
      { label: "Random steps", run: () => {
        const step = this.snapStep(), cells = Math.round(1 / step);
        const lv = [...Array(cells)].map(() => Math.round(Math.random() * 10) / 10);
        set(lv.map((v, i) => [i * step, v, 0, 1]).concat([[1, lv[cells - 1], 0, 0]]));
      } },
      { label: this.curve.release >= 0 ? "Remove release point" : "Add release point at the middle", run: () => {
        this.curve.release = this.curve.release >= 0 ? -1 : 0.5;
        this.commit();
        if (this.curve.release >= 0 && Math.round(this.m.get(this.pre + "loop")) !== 4) this.app.toast('Set Loop to "Release" for the release point to take effect.');
      } },
    ]);
  }
}

class ShapePanel {
  constructor(app, n, title) {
    const pre = `shape${n}.`, m = app.model;
    const { root, controls } = skSection(title || `Shape ${n}`, "shape-panel is-wide");
    this.editor = new ShapeEditor(app, n);
    const body = h("div", { class: "shape-body" }, this.editor.root, controls);
    root.append(body);
    const c = skAddControls(app, controls, [
      [pre + "trigger", "Trigger", "menu"], [pre + "loop", "Loop", "menu"], [pre + "start", "Start", "menu"],
      [pre + "sync", "Sync", "toggle"], [pre + "length", "Length", "menu"], [pre + "time", "Time"],
      [pre + "curve", "Curve", "menu"], [pre + "rate", "Rate"], [pre + "offset", "Offset"], [pre + "depth", "Depth"],
      [pre + "smooth", "Smooth"], [pre + "keyLow", "Lowest key", "menu"], [pre + "keyHigh", "Highest key", "menu"],
      [pre + "velLow", "Lowest vel."], [pre + "velHigh", "Highest vel."]]);
    const sync = (v) => {
      if (c[pre + "length"]) c[pre + "length"].root.hidden = v < 0.5;
      if (c[pre + "time"]) c[pre + "time"].root.hidden = v >= 0.5;
    };
    m.on(pre + "sync", sync);
    sync(m.get(pre + "sync"));
    // Key/velocity ranges only matter for note triggers; a quantised start
    // only for triggers that start the shape (not bar, beat or free).
    const trig = (v) => {
      const t = Math.round(v);
      for (const k of ["keyLow", "keyHigh", "velLow", "velHigh"]) if (c[pre + k]) c[pre + k].root.hidden = t > 1;
      if (c[pre + "start"]) c[pre + "start"].root.hidden = t >= 2 && t <= 4;
    };
    m.on(pre + "trigger", trig);
    trig(m.get(pre + "trigger"));
    // Key ranges read better as note names.
    for (const k of ["keyLow", "keyHigh"]) {
      const sel = c[pre + k] && c[pre + k].select;
      if (sel) for (const o of sel.options) o.textContent = skNoteName(Number(o.value));
    }
    this.root = root;
  }
}

// ---- matrix ---------------------------------------------------------------------------

const SK_SOURCE_GROUPS = [
  ["Envelopes", (s) => /^env\d/.test(s.id)],
  ["LFOs", (s) => /^lfo\d/.test(s.id)],
  ["Shapes", (s) => /^shape\d/.test(s.id)],
  ["Note", (s) => ["velocity", "key", "random", "aftertouch", "note.age", "note.offbeat"].includes(s.id)],
  ["Controllers", (s) => ["modwheel", "bend"].includes(s.id)],
  ["Musical time", (s) => ["beat.phase", "bar.phase", "bar.beat", "downbeat"].includes(s.id)],
  ["Other", (s) => s.id === "const"],
];

function skSourceSelect(model, value, onchange, allowNone) {
  const sel = h("select", { class: "menu-select", onchange: () => onchange(sel.value) });
  if (allowNone) sel.append(h("option", { value: "", text: "No scaling" }));
  const used = new Set();
  for (const [label, test] of SK_SOURCE_GROUPS) {
    const og = h("optgroup", { label });
    for (const s of model.mod.sources) if (test(s)) { og.append(h("option", { value: s.id, text: s.name })); used.add(s.id); }
    if (og.children.length) sel.append(og);
  }
  const custom = model.mod.sources.filter((s) => !used.has(s.id));
  if (custom.length) {
    const og = h("optgroup", { label: model.info.synth.name });
    for (const s of custom) og.append(h("option", { value: s.id, text: s.name }));
    sel.append(og);
  }
  sel.value = value || "";
  return sel;
}

// Bipolar amount slider for a route (not a parameter).
class AmountSlider {
  constructor(value, onchange) {
    this.v = value; this.onchange = onchange;
    this.fill = h("div", { class: "amt-fill" });
    this.track = h("div", { class: "amt-track", role: "slider", tabindex: 0, "aria-label": "Amount", "aria-valuemin": -100, "aria-valuemax": 100 }, h("div", { class: "amt-zero" }), this.fill);
    this.label = h("button", { type: "button", class: "ctl-value amt-value", title: "Type an amount" });
    this.root = h("div", { class: "amt" }, this.track, this.label);
    let start = null;
    this.track.addEventListener("pointerdown", (e) => { this.track.setPointerCapture(e.pointerId); start = { x: e.clientX, v: this.v }; });
    this.track.addEventListener("pointermove", (e) => {
      if (!start) return;
      const w = this.track.clientWidth || 120;
      this.set(start.v + ((e.clientX - start.x) / w) * 2 * (e.shiftKey ? 0.1 : 1));
    });
    this.track.addEventListener("pointerup", () => { start = null; });
    this.track.addEventListener("dblclick", () => this.set(0));
    this.track.addEventListener("keydown", (e) => {
      const s = e.shiftKey ? 0.002 : 0.02;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); this.set(this.v + s); }
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); this.set(this.v - s); }
    });
    this.label.addEventListener("click", () => {
      const input = h("input", { class: "ctl-edit", type: "text", value: (this.v * 100).toFixed(1), "aria-label": "Amount in percent" });
      this.label.replaceWith(input);
      input.select();
      let done = false;
      const finish = (ok) => {
        if (done) return; done = true;
        const n = parseFloat(input.value);
        input.replaceWith(this.label);
        if (ok && Number.isFinite(n)) this.set(n / 100);
      };
      input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); });
      input.addEventListener("blur", () => finish(true));
    });
    this.draw();
  }
  set(v) {
    v = Math.max(-1, Math.min(1, v));
    if (v === this.v) return;
    this.v = v;
    this.draw();
    this.onchange(v);
  }
  draw() {
    const a = 50 + Math.min(0, this.v) * 50, b = 50 + Math.max(0, this.v) * 50;
    this.fill.style.left = a + "%";
    this.fill.style.width = (b - a) + "%";
    const pct = this.v * 100;
    this.label.textContent = (pct > 0 ? "+" : "") + (Math.abs(pct) < 10 ? pct.toFixed(1) : pct.toFixed(0)) + "%";
    this.track.setAttribute("aria-valuenow", pct.toFixed(1));
  }
}

class MatrixPanel {
  constructor(app) {
    this.app = app; this.m = app.model;
    const { root } = skSection("Modulation", "matrix-panel is-wide");
    this.list = h("div", { class: "matrix" });
    this.count = h("span", { class: "matrix-count" });
    this.add = h("button", { type: "button", class: "btn", onclick: () => this.addRoute() }, "Add route");
    root.append(this.list, h("div", { class: "matrix-foot" }, this.add, this.count));
    this.root = root;
    this.m.onMod(() => this.build());
    app.modMeters.on((mm) => this.meter(mm));
    this.build();
  }
  build() {
    const routes = this.m.routes();
    this.routes = routes;
    this.list.textContent = "";
    this.meters = [];
    if (!routes.length) {
      this.list.append(h("p", { class: "matrix-empty", text: "Nothing is modulated yet. Add a route here, or right-click a knob and choose Modulate." }));
    }
    const dsts = this.m.modulatable();
    routes.forEach((r, i) => {
      const update = (patch) => { const next = this.m.routes(); Object.assign(next[i], patch); if (patch.via === "") delete next[i].via; this.m.setRoutes(next); };
      const src = skSourceSelect(this.m, r.src, (v) => update({ src: v }));
      src.setAttribute("aria-label", `Route ${i + 1} source`);
      const dst = h("select", { class: "menu-select", "aria-label": `Route ${i + 1} destination`, onchange: () => update({ dst: dst.value }) });
      const groups = new Map();
      for (const p of dsts) {
        const g = p.group || "Sound";
        if (!groups.has(g)) groups.set(g, h("optgroup", { label: g }));
        groups.get(g).append(h("option", { value: p.id, text: p.name }));
      }
      for (const og of groups.values()) dst.append(og);
      dst.value = r.dst;
      const amt = new AmountSlider(r.amt, (v) => { const next = this.m.routes(); next[i].amt = v; this.m.setRoutes(next); });
      const via = skSourceSelect(this.m, r.via, (v) => update({ via: v }), true);
      via.setAttribute("aria-label", `Route ${i + 1} scaled by`);
      const meter = h("span", { class: "route-meter" }, h("span", { class: "route-meter-fill" }));
      this.meters.push({ el: meter.firstChild, src: this.m.sourceIndex.get(r.src) });
      const remove = h("button", { type: "button", class: "btn btn-quiet btn-small", "aria-label": `Remove route ${i + 1}`, onclick: () => { const next = this.m.routes(); next.splice(i, 1); this.m.setRoutes(next); } }, "Remove");
      this.list.append(h("div", { class: "route" },
        h("div", { class: "route-src" }, meter, src),
        h("span", { class: "route-to", text: "to" }), dst, amt.root,
        h("label", { class: "route-via" }, h("span", { text: "scaled by" }), via), remove));
    });
    this.count.textContent = `${routes.length} of ${this.m.mod.slots} routes`;
    this.add.disabled = routes.length >= this.m.mod.slots;
  }
  addRoute(src, dst, amt = 0.25) {
    const routes = this.m.routes();
    if (routes.length >= this.m.mod.slots) { this.app.toast(`All ${this.m.mod.slots} modulation routes are in use. Remove one to add another.`); return false; }
    const firstLfo = this.m.mod.sources.find((s) => s.id.startsWith("lfo")) || this.m.mod.sources[0];
    routes.push({ src: src || firstLfo.id, dst: dst || this.m.modulatable()[0].id, amt });
    this.m.setRoutes(routes);
    return true;
  }
  meter(mm) {
    for (const r of this.meters || []) {
      const v = Math.max(-1, Math.min(1, mm.source(r.src)));
      r.el.style.left = (50 + Math.min(0, v) * 50) + "%";
      r.el.style.width = Math.abs(v) * 50 + "%";
    }
  }
}
