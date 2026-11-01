// Modulation UI: LFO panels, shape editors, the matrix, and the live
// meters that drive knob rings, LFO meters and shape playheads.

// ---- meters -------------------------------------------------------------------

class ModMeters {
  constructor(model) {
    this.model = model;
    this.ns = model.mod.sources.length;
    this.np = model.params.length;
    this.data = null;
    this.active = false;   // any voice sounding? Live displays rest when not.
    this.subs = new Set();
    this.sourceSubs = new Set();   // (meters) on every update, sounding or not
  }
  update(arr, active) {
    if (!arr || !arr.length) return;
    this.latest = arr;
    // Sources a synth drives globally (a wind gauge) move with nothing playing.
    for (const fn of this.sourceSubs) fn(this);
    // Settle once when playing stops, then stay quiet until it starts again.
    if (!active && !this.active) return;
    this.data = arr;
    this.active = !!active;
    for (const fn of this.subs) fn(this);
  }
  on(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  // A source's latest value, whenever meters arrive (for custom widgets and pages).
  onSource(id, fn) {
    const i = this.model.sourceIndex.get(id);
    if (i === undefined) { console.warn(`[synthkit] no mod source "${id}"`); return () => {}; }
    const sub = () => fn(this.latest[i]);
    this.sourceSubs.add(sub);
    return () => this.sourceSubs.delete(sub);
  }
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

// ---- LFOs the player adds (synth.json standardLfos: { max, start }) --------------
// sk.lfos says how many are in use; the rest are silent and out of sight.

function skLfosInUse(model) { return model.param("sk.lfos") ? Math.round(model.get("sk.lfos")) : model.mod.lfos; }
// False for an LFO (or one of its parameters) that isn't in use.
function skLfoInUse(model, id) {
  const m = /^lfo(\d+)(\.|$)/.exec(id || "");
  return !m || Number(m[1]) <= skLfosInUse(model);
}
function skLfoParams(model, n) { return model.params.filter((p) => p.id.startsWith(`lfo${n}.`)); }

function skAddLfo(app) {
  const m = app.model, n = skLfosInUse(m), cap = m.param("sk.lfos");
  if (!cap || n >= cap.max) return;
  for (const p of skLfoParams(m, n + 1)) m.reset(p.index);   // a fresh LFO
  m.set("sk.lfos", n + 1, "ui");
}

// Removing LFO k moves the ones after it down a place (settings, routes and
// MIDI-learned controllers go with them), so the LFOs in use stay 1…n.
function skRemoveLfo(app, k) {
  const m = app.model, n = skLfosInUse(m);
  if (!m.param("sk.lfos") || k < 1 || k > n) return;
  const names = skLfoParams(m, k).map((p) => p.id.slice(`lfo${k}.`.length));
  for (let j = k; j < n; j++) for (const s of names) m.set(`lfo${j}.${s}`, m.get(`lfo${j + 1}.${s}`), "ui");
  for (const s of names) m.reset(`lfo${n}.${s}`);
  // lfo(k+1) → lfo(k), …; lfo(k) itself → null (gone).
  const move = (id) => {
    const x = /^lfo(\d+)(\..+)?$/.exec(id || "");
    if (!x) return id;
    const i = Number(x[1]);
    return i === k ? null : i > k ? `lfo${i - 1}${x[2] || ""}` : id;
  };
  let dropped = 0;
  if (m.mod.slots) {
    const routes = [];
    for (const r of m.routes()) {
      const src = move(r.src), dst = move(r.dst), via = r.via ? move(r.via) : undefined;
      if (src === null || dst === null || via === null) { dropped++; continue; }
      routes.push(via ? { ...r, src, dst, via } : { ...r, src, dst });
    }
    m.setRoutes(routes);
  }
  if (app.midi && app.midi.map) {
    const map = {};
    for (const [cc, id] of Object.entries(app.midi.map)) { const to = move(id); if (to) map[cc] = to; }
    app.midi.map = map;
    skStore.set(app.midi.key, map);
    app.refreshLearned();
  }
  m.set("sk.lfos", n - 1, "ui");
  app.toast(`Removed LFO ${k}` + (dropped ? ` and ${dropped === 1 ? "its route" : `its ${dropped} routes`}` : "") + (k < n ? `. LFO${n - k > 1 ? "s" : ""} after it moved up one.` : "."));
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
      this.dot.setAttribute("visibility", mm.active ? "visible" : "hidden");
      const v = mm.source(this.src);
      this.dot.setAttribute("cy", (20 - Math.max(-1, Math.min(1, v)) * 17).toFixed(1));
    });
    this.dot.setAttribute("visibility", "hidden");
    this.root = root;
    // The player adds and removes LFOs: show this one only while it's in use.
    if (m.param("sk.lfos")) {
      root.querySelector(".panel-title").append(h("button", { type: "button", class: "panel-remove", "aria-label": `Remove LFO ${n}`, title: `Remove LFO ${n}`, onclick: () => skRemoveLfo(app, n) }, "×"));
      const show = (v) => { root.hidden = n > Math.round(v); };
      m.on("sk.lfos", show);
      show(m.get("sk.lfos"));
    }
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

// Curve points: [x, y, curvature, step, outX, outY, inX, inY, corner].
// Points with 8+ entries have handles (offsets from the point); a segment with
// handles at either end is a cubic Bezier, otherwise the older curvature
// model applies. This must match ShapeCurve::eval in the engine.
function skHasHandles(p) { return p.length >= 8; }

function skBez(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function skEvalCurve(pts, x) {
  if (!pts.length) return 0;
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const [x0, y0, c, hold] = a, [x1, y1] = b;
    if (x > x1) continue;
    if (hold) return y0;
    const w = x1 - x0;
    if (w < 1e-6) return y1;
    if (skHasHandles(a) || skHasHandles(b)) {
      const c1x = x0 + (skHasHandles(a) ? Math.min(Math.max(a[4], 0), w / 2) : 0);
      const c2x = x1 + (skHasHandles(b) ? Math.max(Math.min(b[6], 0), -w / 2) : 0);
      const c1y = y0 + (skHasHandles(a) ? a[5] : 0), c2y = y1 + (skHasHandles(b) ? b[7] : 0);
      let lo = 0, hi = 1, t = (x - x0) / w;
      for (let k = 0; k < 24; k++) {
        const xt = skBez(x0, c1x, c2x, x1, t);
        if (Math.abs(xt - x) < 1e-6) break;
        if (xt < x) lo = t; else hi = t;
        t = 0.5 * (lo + hi);
      }
      return Math.min(1, Math.max(0, skBez(y0, c1y, c2y, y1, t)));
    }
    let t = (x - x0) / w;
    if (c) t = Math.pow(t, Math.pow(2, 3 * c));
    return y0 + (y1 - y0) * t;
  }
  return pts[pts.length - 1][1];
}

// Fit handles to one segment of the older curvature model, keeping both
// handles inside the editor (heights 0..1) so they can always be grabbed.
// Tries a grid of handle reaches and solves the heights by least squares.
// Returns [outX, outY, inX, inY] as offsets from the segment's ends.
function skFitSegment(x0, y0, x1, y1, curvature) {
  const w = x1 - x0, e = Math.pow(2, 3 * (curvature || 0));
  const N = 31, target = [], xs = [];
  for (let k = 1; k <= N; k++) { const f = k / (N + 1); xs.push(f); target.push(y0 + (y1 - y0) * Math.pow(f, e)); }
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  let best = null;
  for (let ia = 0; ia <= 6; ia++) for (let ib = 0; ib <= 6; ib++) {
    const a = ia / 12, b = 1 - ib / 12;   // control x's, in units of the width
    let s11 = 0, s12 = 0, s22 = 0, r1 = 0, r2 = 0;
    const basis = xs.map((x, k) => {
      let lo = 0, hi = 1, t = x;
      for (let j = 0; j < 30; j++) { const xt = skBez(0, a, b, 1, t); if (xt < x) lo = t; else hi = t; t = 0.5 * (lo + hi); }
      const u = 1 - t, b0 = u * u * u, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t * t * t;
      const r = target[k] - y0 * b0 - y1 * b3;
      s11 += b1 * b1; s12 += b1 * b2; s22 += b2 * b2; r1 += b1 * r; r2 += b2 * r;
      return [b0, b1, b2, b3];
    });
    const det = s11 * s22 - s12 * s12;
    let Y1 = det > 1e-12 ? (r1 * s22 - r2 * s12) / det : y0, Y2 = det > 1e-12 ? (s11 * r2 - s12 * r1) / det : y1;
    // Keep inside the box; if one height had to move, re-solve the other.
    if (Y1 !== clamp01(Y1)) { Y1 = clamp01(Y1); if (s22 > 1e-12) Y2 = (r2 - s12 * Y1) / s22; }
    if (Y2 !== clamp01(Y2)) { Y2 = clamp01(Y2); if (s11 > 1e-12) Y1 = clamp01((r1 - s12 * Y2) / s11); }
    Y2 = clamp01(Y2);
    let err = 0;
    basis.forEach(([b0, b1, b2, b3], k) => { const d = y0 * b0 + Y1 * b1 + Y2 * b2 + y1 * b3 - target[k]; err += d * d; });
    if (!best || err < best.err - 1e-12) best = { err, out: [a * w, Y1 - y0, (b - 1) * w, Y2 - y1] };
  }
  return best.out;
}

// Convert a curve that uses the older curvature model to handles, fitting
// each segment.
function skToHandles(pts) {
  if (pts.every(skHasHandles)) return;
  const out = pts.map((p) => [p[0], p[1], 0, p[3] ? 1 : 0, 0, 0, 0, 0, skHasHandles(p) ? (p[8] || 0) : 1]);
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const w = b[0] - a[0];
    if (a[3] || w < 1e-6) continue;
    if (skHasHandles(a) || skHasHandles(b)) {  // already a Bezier segment
      if (skHasHandles(a)) { out[i][4] = a[4]; out[i][5] = a[5]; }
      if (skHasHandles(b)) { out[i + 1][6] = b[6]; out[i + 1][7] = b[7]; }
      continue;
    }
    if (!a[2]) continue;  // a straight line needs no handles
    const [ox, oy, ix, iy] = skFitSegment(a[0], a[1], b[0], b[1], a[2]);
    out[i][4] = ox; out[i][5] = oy;
    out[i + 1][6] = ix; out[i + 1][7] = iy;
  }
  pts.length = 0;
  pts.push(...out);
}

// Shorten a handle (keeping its direction) so its end stays inside the editor:
// heights 0..1, and no further than xMax across (xMax is signed: + for out
// handles, - for in handles).
function skFitHandle(py, dx, dy, xMax) {
  let s = 1;
  if (Math.abs(dx) > Math.abs(xMax) && dx !== 0) s = Math.min(s, Math.abs(xMax / dx));
  if (py + dy > 1) s = Math.min(s, (1 - py) / dy);
  if (py + dy < 0) s = Math.min(s, -py / dy);
  s = Math.max(0, s);
  return [dx * s, dy * s];
}

// Smooth handles for point i: tangent through its neighbours, a third of the
// way to each (shortened if that would leave the editor).
function skSmoothHandles(pts, i) {
  const p = pts[i], prev = pts[i - 1], next = pts[i + 1];
  const slope = prev && next ? (next[1] - prev[1]) / Math.max(1e-6, next[0] - prev[0])
    : next ? (next[1] - p[1]) / Math.max(1e-6, next[0] - p[0])
    : prev ? (p[1] - prev[1]) / Math.max(1e-6, p[0] - prev[0]) : 0;
  const wo = next ? (next[0] - p[0]) / 3 : 0, wi = prev ? (p[0] - prev[0]) / 3 : 0;
  [p[4], p[5]] = skFitHandle(p[1], wo, slope * wo, wo);
  [p[6], p[7]] = skFitHandle(p[1], -wi, -slope * wi, -wi);
  p[8] = 0;
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
    this.g.head.setAttribute("visibility", "hidden");
    this.area = h("div", { class: "shape-area", tabindex: 0, role: "application",
      "aria-label": `Shape ${n} curve editor. Comma and period select points; arrow keys move the selected point; S smooths it; H makes it a step; Delete removes it.` }, this.svg);
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
    this.app.modMeters.on((mm) => this.playhead(mm.active ? mm.shape(n - 1) : null));
    this.bindPointer();
    this.bindKeys();
  }

  setTool(t) {
    this.tool = t;
    this.toolBtns.forEach((b, i) => b.setAttribute("aria-checked", String(["points", "steps"][i] === t)));
    this.hint.textContent = t === "points"
      ? "Click a point to show its handles, then drag them to curve the line. Double-click to add or remove a point; right-click a point for more."
      : "Click or drag to set each step's level.";
    this.draw();
  }

  // Data ---------------------------------------------------------------------------
  curveIndex() { return Math.max(0, Math.round(this.m.get(this.pre + "curve")) - 1); }
  load() {
    this.all = this.m.shapes();
    const s = this.all[this.n - 1] || (this.all[this.n - 1] = { curves: [] });
    while (s.curves.length <= this.curveIndex()) s.curves.push({ points: [[0, 1, -0.5, 0], [1, 0, 0, 0]] });
    this.curve = s.curves[this.curveIndex()];
    this.preview = null;
    if (this.sel >= this.curve.points.length) this.sel = -1;
  }
  // Older curves switch to handles the first time they're edited; until then
  // they display (and play) exactly as saved.
  editable() { skToHandles(this.curve.points); this.preview = null; return this.curve.points; }
  // Points with handles for display: an older curve shows the handles it will
  // get, without changing it until it's edited.
  shown() {
    const pts = this.curve.points;
    if (pts.every(skHasHandles)) return pts;
    if (!this.preview) { this.preview = pts.map((p) => p.slice()); skToHandles(this.preview); }
    return this.preview;
  }
  commit() {
    // Keep points ordered and the ends pinned to 0 and 1.
    const p = this.curve.points;
    this.preview = null;
    p.sort((a, b) => a[0] - b[0]);
    p[0][0] = 0;
    p[p.length - 1][0] = 1;
    // Write only this shape's curve into the current data: other shape
    // editors may have changed theirs since this one loaded.
    const fresh = this.m.shapes();
    const mine = this.all[this.n - 1];
    fresh[this.n - 1] = mine;
    this.all = fresh;
    this.m.setShapes(fresh, true);
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
    return Math.max(1 / 64, 0.25 / beats);  // sixteenth notes
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
  sx() { return this.W - 2 * this.pad; }   // pixels per unit x
  sy() { return this.H - 2 * this.pad; }   // pixels per unit y
  local(e) {
    const r = this.svg.getBoundingClientRect();
    return { mx: (e.clientX - r.left) * (this.W / r.width), my: (e.clientY - r.top) * (this.H / r.height) };
  }
  fromEvent(e) {
    const { mx, my } = this.local(e);
    const x = (mx - this.pad) / this.sx(), y = 1 - (my - this.pad) / this.sy();
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  }
  snapX(x, e) {
    if (!this.snap || (e && e.shiftKey)) return x;
    const s = this.snapStep();
    return Math.round(x / s) * s;
  }

  // Where the selected point's handles are drawn (in pixels). Handles of zero
  // length are shown a short way out along the curve's direction, so there's
  // always something to grab.
  handlePositions(i) {
    const pts = this.shown(), p = pts[i];
    const out = [];
    const ghost = 26;
    const add = (kind, dx, dy, neighbour) => {
      if (!neighbour) return;
      let hx = this.px(p[0] + dx), hy = this.py(p[1] + dy);
      if (Math.hypot(hx - this.px(p[0]), hy - this.py(p[1])) < 3) {
        const dirx = this.px(neighbour[0]) - this.px(p[0]), diry = this.py(neighbour[1]) - this.py(p[1]);
        const len = Math.hypot(dirx, diry) || 1, reach = Math.min(ghost, len / 3);
        hx = this.px(p[0]) + (dirx / len) * reach; hy = this.py(p[1]) + (diry / len) * reach;
      }
      // A handle outside the editor (from an older patch) is shown pinned to
      // the edge, where it can still be grabbed; dragging brings it inside.
      const top = this.py(1), bottom = this.py(0);
      const pinned = hy < top - 0.5 || hy > bottom + 0.5;
      if (pinned) {
        const cy = Math.min(bottom, Math.max(top, hy));
        hx = this.px(p[0]) + (hx - this.px(p[0])) * ((cy - this.py(p[1])) / ((hy - this.py(p[1])) || 1));
        hy = cy;
      }
      out.push({ kind, x: hx, y: hy, pinned });
    };
    const has = skHasHandles(p);
    if (!p[3]) add("out", has ? Math.min(Math.max(p[4], 0), pts[i + 1] ? (pts[i + 1][0] - p[0]) / 2 : 0) : 0, has ? p[5] : 0, pts[i + 1]);
    add("in", has ? Math.max(Math.min(p[6], 0), pts[i - 1] ? -(p[0] - pts[i - 1][0]) / 2 : 0) : 0, has ? p[7] : 0, pts[i - 1]);
    return out;
  }

  // What's under the pointer, by position rather than by DOM element (the
  // editor redraws between clicks, so element targets go stale).
  hit(e) {
    const { mx, my } = this.local(e);
    const pts = this.curve.points;
    if (Math.round(this.m.get(this.pre + "loop")) === 4) {
      const rx = this.px(this.curve.release >= 0 ? this.curve.release : 1);
      if (Math.abs(mx - rx) <= 8 && my <= 16) return { kind: "rel" };
    }
    if (this.tool === "points" && this.sel >= 0 && this.sel < pts.length) {
      for (const hp of this.handlePositions(this.sel)) if (Math.hypot(mx - hp.x, my - hp.y) < 9) return { kind: "handle", i: this.sel, which: hp.kind };
    }
    let best = null, bd = 10;
    pts.forEach((p, i) => { const d = Math.hypot(mx - this.px(p[0]), my - this.py(p[1])); if (d < bd) { bd = d; best = { kind: "pt", i }; } });
    return best || { kind: "none" };
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
      for (let b = 0; b <= beats + 1e-9; b += 0.25) {
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
    const steps = Math.max(120, Math.round(this.W / 2));
    for (let i = 0; i <= steps; i++) {
      const x = i / steps;
      d += (i ? "L" : "M") + this.px(x).toFixed(1) + " " + this.py(skEvalCurve(pts, x)).toFixed(1) + " ";
    }
    this.g.line.setAttribute("d", d);
    this.g.fill.setAttribute("d", d + `L ${this.px(1)} ${this.py(0)} L ${this.px(0)} ${this.py(0)} Z`);

    this.g.points.textContent = "";
    this.g.handles.textContent = "";
    if (this.tool === "points") {
      if (this.sel >= 0 && this.sel < pts.length) {
        const p = this.shown()[this.sel];
        for (const hp of this.handlePositions(this.sel)) {
          this.g.handles.append(svg("line", { class: "handle-arm", x1: this.px(p[0]), y1: this.py(p[1]), x2: hp.x, y2: hp.y }),
            svg("circle", { class: "handle-knob" + (hp.pinned ? " is-pinned" : ""), cx: hp.x, cy: hp.y, r: 4.5 }));
        }
      }
      pts.forEach((p, i) => {
        const smooth = skHasHandles(p) && !p[8];
        this.g.points.append(svg(smooth || !skHasHandles(p) ? "circle" : "rect", Object.assign(
          { class: "shape-point" + (p[3] ? " is-step" : "") + (i === this.sel ? " is-sel" : "") },
          smooth || !skHasHandles(p)
            ? { cx: this.px(p[0]), cy: this.py(p[1]), r: i === this.sel ? 6 : 5 }
            : { x: this.px(p[0]) - 5, y: this.py(p[1]) - 5, width: 10, height: 10, rx: 1.5 })));
      });
    }

    this.g.rel.textContent = "";
    if (Math.round(this.m.get(this.pre + "loop")) === 4) {
      const rx = this.px(this.curve.release >= 0 ? this.curve.release : 1);
      this.g.rel.append(svg("line", { x1: rx, x2: rx, y1: this.pad, y2: this.H - this.pad }),
        svg("rect", { class: "release-grip", x: rx - 6, y: 0, width: 12, height: 12, rx: 2 }));
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
  moveHandle(i, which, e) {
    const pts = this.editable(), p = pts[i];
    const { mx, my } = this.local(e);
    const sx = this.sx(), sy = this.sy();
    let dx = (mx - this.px(p[0])) / sx, dy = -(my - this.py(p[1])) / sy;
    const wOut = pts[i + 1] ? (pts[i + 1][0] - p[0]) / 2 : 0, wIn = pts[i - 1] ? (p[0] - pts[i - 1][0]) / 2 : 0;
    if (e.altKey) p[8] = 1;  // Alt/Option breaks the pair
    dy = Math.min(1 - p[1], Math.max(-p[1], dy));   // keep the handle inside the editor
    if (which === "out") { p[4] = Math.min(Math.max(dx, 0), wOut); p[5] = dy; }
    else { p[6] = Math.max(Math.min(dx, 0), -wIn); p[7] = dy; }
    if (!p[8]) {
      // Smooth point: the other handle points the opposite way, keeping its length.
      const [ax, ay] = which === "out" ? [p[4], p[5]] : [p[6], p[7]];
      const [ox, oy] = which === "out" ? [p[6], p[7]] : [p[4], p[5]];
      const aLen = Math.hypot(ax * sx, ay * sy);
      let oLen = Math.hypot(ox * sx, oy * sy);
      if (oLen < 3) oLen = aLen;
      if (aLen > 0.5) {
        const nx = (-ax * sx / aLen) * oLen / sx, ny = (-ay * sy / aLen) * oLen / sy;
        if (which === "out") [p[6], p[7]] = skFitHandle(p[1], Math.min(nx, 0), ny, -wIn);
        else [p[4], p[5]] = skFitHandle(p[1], Math.max(nx, 0), ny, wOut);
      }
    }
  }

  bindPointer() {
    let drag = null;
    let lastDown = { t: 0, x: 0, y: 0 };
    this.svg.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      // Without this the browser starts selecting text as the drag drifts out
      // of the editor, and a selection over the editor hijacks the next press.
      e.preventDefault();
      window.getSelection().removeAllRanges();
      this.area.focus({ preventScroll: true });
      const now = performance.now();
      const isDouble = now - lastDown.t < 400 && Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) < 8;
      lastDown = isDouble ? { t: 0, x: 0, y: 0 } : { t: now, x: e.clientX, y: e.clientY };
      if (isDouble && this.tool === "points") { e.preventDefault(); this.onDouble(e); return; }
      const hit = this.hit(e);
      this.svg.setPointerCapture(e.pointerId);
      if (hit.kind === "rel") { drag = { kind: "rel" }; return; }
      if (this.tool === "steps") { drag = { kind: "steps" }; this.paintStep(e); return; }
      if (hit.kind === "handle") { drag = hit; return; }
      if (hit.kind === "pt") { this.sel = hit.i; drag = { kind: "pt", i: hit.i }; this.draw(); return; }
      this.sel = -1;
      this.draw();
    });
    this.svg.addEventListener("pointermove", (e) => {
      if (!drag) return;
      if (drag.kind === "steps") { this.paintStep(e); return; }
      const { x, y } = this.fromEvent(e);
      if (drag.kind === "pt") {
        const pts = this.editable(), i = drag.i;
        const lo = i === 0 ? 0 : pts[i - 1][0], hi = i === pts.length - 1 ? 1 : pts[i + 1][0];
        if (i !== 0 && i !== pts.length - 1) pts[i][0] = Math.min(hi, Math.max(lo, this.snapX(x, e)));
        pts[i][1] = y;
      } else if (drag.kind === "handle") {
        this.moveHandle(drag.i, drag.which, e);
      } else if (drag.kind === "rel") {
        this.curve.release = Math.min(1, Math.max(0, this.snapX(x, e)));
      }
      this.commit();
    });
    const end = () => { drag = null; };
    this.svg.addEventListener("pointerup", end);
    this.svg.addEventListener("pointercancel", end);
    // Double-click (or double-tap), detected here rather than with the dblclick
    // event, which browsers drop when the editor redraws between the clicks.
    this.onDouble = (e) => {
      const hit = this.hit(e);
      if (hit.kind === "pt") { this.removePoint(hit.i); return; }
      if (hit.kind !== "none") return;
      const pts = this.editable();
      if (pts.length >= 64) { this.app.toast("A curve can have up to 64 points."); return; }
      const { x, y } = this.fromEvent(e);
      const sx = this.snapX(x, e);
      if (sx <= 0 || sx >= 1) return;
      const p = [sx, y, 0, 0, 0, 0, 0, 0, 0];
      pts.push(p);
      pts.sort((a, b) => a[0] - b[0]);
      this.sel = pts.indexOf(p);
      skSmoothHandles(pts, this.sel);
      this.commit();
    };
    this.svg.addEventListener("contextmenu", (e) => {
      const hit = this.hit(e);
      if (hit.kind !== "pt") return;
      e.preventDefault();
      this.sel = hit.i;
      this.draw();
      this.pointMenu(hit.i, e.clientX, e.clientY);
    });
  }

  removePoint(i) {
    const pts = this.editable();
    if (i <= 0 || i >= pts.length - 1) { this.app.toast("The first and last points can't be removed, but you can drag them up and down."); return; }
    pts.splice(i, 1);
    this.sel = -1;
    this.commit();
  }

  pointMenu(i, x, y) {
    const pts = this.editable(), p = pts[i];
    const mid = i > 0 && i < pts.length - 1;
    this.app.menu(x, y, [
      { label: "Smooth (handles move together)", run: () => { skSmoothHandles(pts, i); this.commit(); } },
      { label: "Corner (handles move separately)", run: () => { p[8] = 1; this.commit(); } },
      { label: "Straight lines", run: () => { p[4] = p[5] = p[6] = p[7] = 0; p[8] = 1; this.commit(); } },
      { label: p[3] ? "Not a step" : "Step (hold until the next point)", run: () => { p[3] = p[3] ? 0 : 1; this.commit(); } },
      null,
      { label: "Delete point", run: () => this.removePoint(i), disabled: !mid },
    ]);
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
      const n = this.curve.points.length;
      if (e.key === "," || e.key === ".") {
        this.sel = this.sel < 0 ? 0 : (this.sel + (e.key === "." ? 1 : -1) + n) % n;
        e.preventDefault(); e.stopPropagation(); this.draw(); return;
      }
      if (this.sel < 0) return;
      const pts = this.editable(), p = pts[this.sel], fine = e.shiftKey;
      const dx = fine ? 0.005 : this.snapStep(), dy = fine ? 0.01 : 0.05;
      let used = true;
      if (e.key === "ArrowUp") p[1] = Math.min(1, p[1] + dy);
      else if (e.key === "ArrowDown") p[1] = Math.max(0, p[1] - dy);
      else if (e.key === "ArrowLeft" && this.sel > 0 && this.sel < pts.length - 1) p[0] = Math.max(pts[this.sel - 1][0], p[0] - dx);
      else if (e.key === "ArrowRight" && this.sel > 0 && this.sel < pts.length - 1) p[0] = Math.min(pts[this.sel + 1][0], p[0] + dx);
      else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); e.stopPropagation(); this.removePoint(this.sel); return; }
      else if (e.key === "h" || e.key === "H") p[3] = p[3] ? 0 : 1;
      else if (e.key === "s" || e.key === "S") skSmoothHandles(pts, this.sel);
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
    for (const s of model.mod.sources) if (test(s)) {
      used.add(s.id);
      if (skLfoInUse(model, s.id) || s.id === value) og.append(h("option", { value: s.id, text: s.name }));
    }
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
    this.track.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.track.focus({ preventScroll: true });
      this.track.setPointerCapture(e.pointerId);
      start = { x: e.clientX, v: this.v };
    });
    this.track.addEventListener("pointermove", (e) => {
      if (!start) return;
      const w = this.track.clientWidth || 120;
      this.set(start.v + ((e.clientX - start.x) / w) * 2 * (e.shiftKey ? 0.1 : 1));
    });
    this.track.addEventListener("pointerup", () => { start = null; });
    this.track.addEventListener("pointercancel", () => { start = null; });
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
    // Rows edit the matrix themselves; rebuilding them mid-drag would end the
    // drag, so only rebuild for changes made elsewhere (presets, Modulate…).
    this.m.onMod(() => { if (!this.editing) this.build(); });
    // Sources and destinations follow the LFOs in use.
    this.m.on("sk.lfos", () => this.build());
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
      const shown = dsts.filter((p) => skLfoInUse(this.m, p.id) || p.id === r.dst);
      const update = (patch) => { const next = this.m.routes(); Object.assign(next[i], patch); if (patch.via === "") delete next[i].via; this.m.setRoutes(next); };
      const setAmt = (v) => {
        const next = this.m.routes();
        next[i].amt = v;
        this.editing = true;
        try { this.m.setRoutes(next); } finally { this.editing = false; }
      };
      const src = skSourceSelect(this.m, r.src, (v) => update({ src: v }));
      src.setAttribute("aria-label", `Route ${i + 1} source`);
      const dst = h("select", { class: "menu-select", "aria-label": `Route ${i + 1} destination`, onchange: () => update({ dst: dst.value }) });
      const groups = new Map();
      for (const p of shown) {
        const g = p.group || "Sound";
        if (!groups.has(g)) groups.set(g, h("optgroup", { label: g }));
        groups.get(g).append(h("option", { value: p.id, text: p.name }));
      }
      for (const og of groups.values()) dst.append(og);
      dst.value = r.dst;
      const amt = new AmountSlider(r.amt, setAmt);
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
    const firstLfo = this.m.mod.sources.find((s) => /^lfo\d/.test(s.id) && skLfoInUse(this.m, s.id)) || this.m.mod.sources[0];
    const firstDst = this.m.modulatable().find((p) => skLfoInUse(this.m, p.id));
    routes.push({ src: src || firstLfo.id, dst: dst || firstDst.id, amt });
    this.m.setRoutes(routes);
    return true;
  }
  meter(mm) {
    for (const r of this.meters || []) {
      const v = mm.active ? Math.max(-1, Math.min(1, mm.source(r.src))) : 0;
      r.el.style.left = (50 + Math.min(0, v) * 50) + "%";
      r.el.style.width = Math.abs(v) * 50 + "%";
    }
  }
}
