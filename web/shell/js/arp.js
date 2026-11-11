// The pattern editor for the arpeggiator and the sequencer (API.md §4b): a
// piano roll. For the arpeggiator its rows are chord tones (row 1 the lowest
// held note; rows past the held notes carry on an octave up). For the
// sequencer they're intervals from each key: semitones, or scale steps with a
// scale set. Each has its own bank of patterns, custom state "sk.arp" and
// "sk.seq": { patterns: [{ steps, notes: [[step, row, length, velocity,
// chance?], …] } × 8] }, and `arp.pattern` picks one.

const SK_ARP = { patterns: 8, maxSteps: 64, rowLo: -24, rowHi: 47, patternMode: 7 };
let skArpClipboard = null;

class ArpPatternPanel {
  constructor(app, title) {
    this.app = app;
    this.m = app.model;
    this.sel = -1;            // selected note (index into this.notes)
    this.lane = "vel";        // lower lane: "vel" or "chance"
    this.lastVel = 100;
    this.head = -1;
    this.W = 600;

    const { root } = skSection(title || "Arp pattern", "arp-pattern-panel is-wide");
    this.root = root;

    // Pattern slots, bound to arp.pattern.
    this.slotSeg = h("div", { class: "seg seg-small", role: "radiogroup", "aria-label": "Pattern" });
    this.slotBtns = [];
    for (let i = 1; i <= SK_ARP.patterns; i++) {
      const b = h("button", { type: "button", class: "seg-btn", role: "radio", text: String(i), title: `Pattern ${i}`,
        onclick: () => this.m.set("arp.pattern", i) });
      this.slotBtns.push(b);
    }
    this.slotSeg.append(...this.slotBtns);

    // Length in steps.
    this.stepsOut = h("span", { class: "arp-steps-value", "aria-live": "polite" });
    const stepBtn = (d, label, text) => h("button", { type: "button", class: "btn btn-small", "aria-label": label, text,
      onclick: () => this.setSteps(this.pattern.steps + d) });
    this.stepsBox = h("div", { class: "arp-steps" }, h("span", { class: "arp-label", text: "Steps" }),
      stepBtn(-1, "Fewer steps", "−"), this.stepsOut, stepBtn(1, "More steps", "+"));

    const laneSeg = h("div", { class: "seg seg-small", role: "radiogroup", "aria-label": "Lower lane" });
    this.laneBtns = [["vel", "Velocity"], ["chance", "Chance"]].map(([k, t]) =>
      h("button", { type: "button", class: "seg-btn", role: "radio", text: t, onclick: () => { this.lane = k; this.syncBar(); this.draw(); } }));
    laneSeg.append(...this.laneBtns);

    this.toolsBtn = h("button", { type: "button", class: "btn btn-small btn-quiet", onclick: (e) => this.toolsMenu(e) }, "Edit…");
    this.genBtn = h("button", { type: "button", class: "btn btn-small", "aria-expanded": "false", onclick: () => this.toggleGen() }, "Generate…");
    this.useBtn = h("button", { type: "button", class: "btn btn-small arp-use", onclick: () => this.m.set("arp.mode", SK_ARP.patternMode) }, "Play this pattern");
    this.bar = h("div", { class: "shape-bar arp-bar" }, h("span", { class: "arp-label", text: "Pattern" }), this.slotSeg,
      this.stepsBox, laneSeg, this.toolsBtn, this.genBtn, this.useBtn);
    this.buildGen();

    this.svg = svg("svg", { class: "arp-svg", "aria-hidden": "true" });
    this.area = h("div", { class: "shape-area arp-area", tabindex: 0, role: "application",
      "aria-label": "Arp pattern editor. Rows are chord tones: 1 is the lowest held note. Click to add a note, drag to move it, drag its right end to lengthen it, double-click to remove it. Arrow keys move the selected note, Shift with left and right changes its length, Delete removes it." }, this.svg);
    this.hint = h("p", { class: "shape-hint arp-hint", text: "Rows are chord tones: 1 is the lowest note you hold, 2 the next… Rows past the notes you hold play an octave up. Click to add a note; drag to move; drag its end to lengthen; double-click to remove." });
    root.append(this.bar, this.gen, this.area, this.hint);

    this.load();
    for (const id of ["sk.arp", "sk.seq"]) this.m.onCustom(id, () => { if (!this.committing && id === this.bankId()) { this.load(); this.draw(); } });
    const retype = () => { this.sel = -1; this.genLive = false; this.undo = null; this.load(); this.syncBar(); this.syncGen(); this.draw(); };
    this.m.on("arp.on", retype);
    if (this.m.param("arp.scale")) this.m.on("arp.scale", () => { this.syncBar(); this.draw(); });
    this.m.on("arp.pattern", () => { this.sel = -1; this.genLive = false; this.undo = null; this.load(); this.syncBar(); this.syncGen(); this.draw(); });
    this.m.on("arp.mode", () => this.syncBar());
    // Playhead: while a phrase is running (its envelope above silence), even
    // between notes, from the arp.step and arp.phrase sources.
    const si = this.m.sourceIndex;
    if (si && si.has("arp.step") && si.has("arp.phrase")) {
      const iStep = si.get("arp.step");
      this.app.modMeters.onSource("arp.phrase", (phrase) => {
        const mm = this.app.modMeters;
        const playing = phrase > 1e-4 && (this.isSeq() || (this.type() === 1 && Math.round(this.m.get("arp.mode")) === SK_ARP.patternMode));
        const step = playing ? Math.round(mm.latest[iStep] * this.pattern.steps) % this.pattern.steps : -1;
        if (step !== this.head) { this.head = step; this.drawHead(); }
      });
    }
    new ResizeObserver(() => this.resize()).observe(this.area);
    this.bindPointer();
    this.bindKeys();
    this.syncBar();
  }

  // Data ---------------------------------------------------------------------------
  type() { return Math.round(this.m.get("arp.on")); }              // 0 off, 1 arp, 2 sequencer
  isSeq() { return this.type() === 2 && this.m.custom("sk.seq") !== undefined; }
  bankId() { return this.isSeq() ? "sk.seq" : "sk.arp"; }
  scaled() { return this.isSeq() && this.m.param("arp.scale") && Math.round(this.m.get("arp.scale")) > 0; }
  index() { return Math.min(SK_ARP.patterns, Math.max(1, Math.round(this.m.get("arp.pattern")))) - 1; }
  load() {
    const bank = this.m.custom(this.bankId()) || {};
    const pats = Array.isArray(bank.patterns) ? bank.patterns : [];
    while (pats.length < SK_ARP.patterns) pats.push({ steps: 16, notes: [] });
    this.bank = { ...bank, patterns: pats };
    const p = pats[this.index()];
    this.pattern = { steps: Math.min(SK_ARP.maxSteps, Math.max(1, Math.round(p.steps || 16))) };
    this.notes = (p.notes || []).map((n) => ({ s: n[0] | 0, r: Math.round(n[1] || 0), l: Math.max(1, n[2] | 0 || 1), v: n[3] === undefined ? 100 : n[3] | 0, c: n[4] === undefined ? 100 : n[4] | 0 }));
    if (this.sel >= this.notes.length) this.sel = -1;
  }
  commit(byHand) {
    if (byHand && this.genLive) { this.genLive = false; this.syncGen(); }
    const notes = this.notes
      .filter((n) => n.s >= 0 && n.s < this.pattern.steps)
      .sort((a, b) => a.s - b.s || a.r - b.r)
      .map((n) => (n.c < 100 ? [n.s, n.r, n.l, n.v, n.c] : [n.s, n.r, n.l, n.v]));
    const selNote = this.notes[this.sel];
    // Write only this pattern into the latest bank.
    const fresh = this.m.custom(this.bankId()) || {};
    const pats = Array.isArray(fresh.patterns) ? fresh.patterns : [];
    while (pats.length < SK_ARP.patterns) pats.push({ steps: 16, notes: [] });
    pats[this.index()] = { steps: this.pattern.steps, notes };
    this.committing = true;
    this.m.setCustom(this.bankId(), { ...fresh, patterns: pats });
    this.committing = false;
    this.load();
    // Keep the selection on the same note after sorting.
    this.sel = selNote ? this.notes.findIndex((n) => n.s === selNote.s && n.r === selNote.r) : -1;
    this.draw();
  }
  setSteps(n) {
    n = Math.min(SK_ARP.maxSteps, Math.max(1, Math.round(n)));
    if (n === this.pattern.steps) return;
    this.pattern.steps = n;
    if (this.genLive) { this.generate(false); this.syncBar(); return; }   // a generated pattern is redrawn at the new length
    for (const note of this.notes) note.l = Math.min(note.l, Math.max(1, n - note.s));
    this.commit(true);
    this.syncBar();
  }

  syncBar() {
    const idx = this.index();
    this.slotBtns.forEach((b, i) => b.setAttribute("aria-checked", String(i === idx)));
    this.laneBtns.forEach((b, i) => b.setAttribute("aria-checked", String(["vel", "chance"][i] === this.lane)));
    this.stepsOut.textContent = String(this.pattern.steps);
    // The arpeggiator plays patterns only in Pattern mode; the sequencer always does.
    this.useBtn.hidden = this.type() !== 1 || Math.round(this.m.get("arp.mode")) === SK_ARP.patternMode;
    this.hint.textContent = this.isSeq()
      ? (this.scaled() ? "Rows are steps along the scale, up or down from each key you play (Key is the key itself). Every key gets its own copy of the pattern."
                       : "Rows are semitones up or down from each key you play (Key is the key itself; ±12 the octaves). Every key gets its own copy of the pattern.")
        + " Click to add a note; drag to move; drag its end to lengthen; double-click to remove."
      : "Rows are chord tones: 1 is the lowest note you hold, 2 the next… Rows past the notes you hold play an octave up. Click to add a note; drag to move; drag its end to lengthen; double-click to remove.";
    // Rename only the title's text: a folding panel's title holds its toggle
    // (the name in a span) and maybe an info button, which must survive.
    const name = this.isSeq() ? "Sequencer pattern" : "Arp pattern";
    const title = this.root.querySelector(":scope > .panel-title");
    const label = title.querySelector(".panel-toggle > span") || [...title.childNodes].find((n) => n.nodeType === 3);
    if (label) label.textContent = name; else title.prepend(name);
  }

  // Geometry -------------------------------------------------------------------------
  // Rows shown: always 1–12 and one below, growing to fit the pattern plus a
  // spare row, so a note on the edge row can be dragged further.
  rowRange() {
    let [lo, hi] = this.isSeq() ? (this.scaled() ? [-3, 9] : [-5, 12]) : [-1, 11];
    for (const n of this.notes) { lo = Math.min(lo, n.r - 1); hi = Math.max(hi, n.r + 1); }
    return [Math.max(SK_ARP.rowLo, lo), Math.min(SK_ARP.rowHi, hi)];
  }
  layout() {
    const [lo, hi] = this.rowRange();
    const rows = hi - lo + 1;
    const rowH = this.W < 480 ? 13 : 15;
    const labelW = 30, laneGap = 8, laneH = 44;
    const gridTop = 2, gridH = rows * rowH;
    const stepW = (this.W - labelW - 4) / this.pattern.steps;
    return { lo, hi, rows, rowH, labelW, gridTop, gridH, stepW, laneTop: gridTop + gridH + laneGap, laneH, H: gridTop + gridH + laneGap + laneH + 4 };
  }
  resize() {
    this.W = Math.max(280, Math.round(this.area.clientWidth));
    this.draw();
  }
  cellAt(x, y, L = this.layout()) {
    const s = Math.floor((x - L.labelW) / L.stepW);
    const r = L.hi - Math.floor((y - L.gridTop) / L.rowH);
    return { s: Math.min(this.pattern.steps - 1, Math.max(0, s)), r: Math.min(L.hi, Math.max(L.lo, r)), inGrid: y < L.gridTop + L.gridH + 2, inLane: y >= L.laneTop - 4 };
  }
  noteAt(x, y, L = this.layout()) {
    // Topmost first: the selected note, then the rest from last drawn.
    const order = [...this.notes.keys()].sort((a, b) => (a === this.sel) - (b === this.sel));
    for (let k = order.length - 1; k >= 0; k--) {
      const i = order[k], n = this.notes[i];
      const x0 = L.labelW + n.s * L.stepW, x1 = x0 + Math.min(n.l, this.pattern.steps - n.s) * L.stepW;
      const y0 = L.gridTop + (L.hi - n.r) * L.rowH;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y0 + L.rowH) return { i, edge: x >= x1 - Math.min(8, L.stepW * 0.35) };
    }
    return null;
  }
  point(e) {
    const r = this.svg.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (this.W / r.width), y: (e.clientY - r.top) * (this.H / r.height) };
  }

  // Drawing ---------------------------------------------------------------------------
  draw() {
    const L = this.layout();
    this.H = L.H;
    this.svg.setAttribute("viewBox", `0 0 ${this.W} ${L.H}`);
    this.svg.setAttribute("width", this.W);
    this.svg.setAttribute("height", L.H);
    this.svg.replaceChildren();
    const g = svg("g");
    // Rows: shaded alternately, row 1 (the lowest held note) marked.
    for (let r = L.lo; r <= L.hi; r++) {
      const y = L.gridTop + (L.hi - r) * L.rowH;
      if (r % 2 === 0) g.append(svg("rect", { class: "arp-row-alt", x: L.labelW, y, width: this.W - L.labelW, height: L.rowH }));
      const octave = this.isSeq() && r !== 0 && r % (this.scaled() ? this.scaleSize() : 12) === 0;
      const t = svg("text", { class: "arp-row-label" + (r === 0 ? " is-root" : "") + (octave ? " is-octave" : ""), x: L.labelW - 6, y: y + L.rowH * 0.72, "text-anchor": "end" });
      t.textContent = this.rowLabel(r);
      g.append(t);
    }
    // A line under row 1 (the key, for the sequencer): below it, the held
    // notes an octave down (or intervals below the key).
    const yRoot = L.gridTop + (L.hi + 1) * L.rowH;   // bottom of row index 0
    g.append(svg("line", { class: "arp-root-line", x1: L.labelW, x2: this.W, y1: yRoot, y2: yRoot }));
    // Steps: beats (every 4 steps) stronger.
    for (let s = 0; s <= this.pattern.steps; s++) {
      const x = L.labelW + s * L.stepW;
      const cls = s % 16 === 0 ? "grid-bar" : s % 4 === 0 ? "grid-beat" : "grid-sub";
      g.append(svg("line", { class: cls, x1: x, x2: x, y1: L.gridTop, y2: L.gridTop + L.gridH }));
      g.append(svg("line", { class: cls, x1: x, x2: x, y1: L.laneTop, y2: L.laneTop + L.laneH }));
    }
    g.append(svg("line", { class: "grid-beat", x1: L.labelW, x2: this.W, y1: L.laneTop + L.laneH, y2: L.laneTop + L.laneH }));
    const laneLabel = svg("text", { class: "arp-row-label", x: L.labelW - 6, y: L.laneTop + 12, "text-anchor": "end" });
    laneLabel.textContent = this.lane === "vel" ? "Vel" : "%";
    g.append(laneLabel);
    this.svg.append(g);

    // Notes, the selected one on top.
    const order = [...this.notes.keys()].sort((a, b) => (a === this.sel) - (b === this.sel));
    for (const i of order) {
      const n = this.notes[i];
      const x = L.labelW + n.s * L.stepW + 1, w = Math.max(3, Math.min(n.l, this.pattern.steps - n.s) * L.stepW - 2);
      const y = L.gridTop + (L.hi - n.r) * L.rowH + 1;
      const rect = svg("rect", { class: "arp-note" + (i === this.sel ? " is-sel" : "") + (n.c < 100 ? " is-chance" : ""),
        x, y, width: w, height: L.rowH - 2, rx: 2.5, "fill-opacity": (0.35 + 0.65 * n.v / 127).toFixed(2) });
      this.svg.append(rect);
      if (n.c < 100 && w > 26) {
        const t = svg("text", { class: "arp-note-text", x: x + 3, y: y + L.rowH * 0.66 });
        t.textContent = `${n.c}%`;
        this.svg.append(t);
      }
      // Lane bar.
      const val = this.lane === "vel" ? n.v / 127 : n.c / 100;
      const bw = Math.max(3, Math.min(L.stepW - 4, 10));
      const bx = L.labelW + n.s * L.stepW + (L.stepW - bw) / 2;
      this.svg.append(svg("rect", { class: "arp-lane-bar" + (i === this.sel ? " is-sel" : ""), x: bx, y: L.laneTop + L.laneH * (1 - val), width: bw, height: Math.max(1, L.laneH * val) }));
    }
    this.headEl = svg("rect", { class: "arp-head", x: 0, y: L.gridTop, width: L.stepW, height: L.gridH, visibility: "hidden" });
    this.svg.append(this.headEl);
    this.drawHead();
  }
  // Notes per octave in the sequencer's scale (for marking the octave rows).
  scaleSize() {
    const name = this.m.param("arp.scale").choices[Math.round(this.m.get("arp.scale"))] || "";
    return /Pentatonic/.test(name) ? 5 : /Blues|Whole/.test(name) ? 6 : /Chromatic/.test(name) ? 12 : 7;
  }
  rowLabel(r) {
    if (!this.isSeq()) return r >= 0 ? String(r + 1) : `−${-r}`;
    if (r === 0) return "Key";
    return r > 0 ? `+${r}` : `−${-r}`;
  }
  drawHead() {
    if (!this.headEl) return;
    const L = this.layout();
    if (this.head < 0) { this.headEl.setAttribute("visibility", "hidden"); return; }
    this.headEl.setAttribute("x", L.labelW + this.head * L.stepW);
    this.headEl.setAttribute("width", L.stepW);
    this.headEl.setAttribute("visibility", "visible");
  }

  // Editing ----------------------------------------------------------------------------
  bindPointer() {
    let drag = null;
    this.area.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.area.focus({ preventScroll: true });
      const L = this.layout(), p = this.point(e), c = this.cellAt(p.x, p.y, L);
      if (p.x < L.labelW) return;
      this.area.setPointerCapture(e.pointerId);
      if (c.inLane && !c.inGrid) {
        drag = { kind: "lane" };
        this.laneSet(p, L);
        return;
      }
      const hit = this.noteAt(p.x, p.y, L);
      // Double-click (or double-tap) removes a note. Detected here: browsers
      // drop the dblclick event when the editor redraws between the clicks.
      const now = performance.now(), last = this.lastDown;
      this.lastDown = { t: now, x: p.x, y: p.y, created: !hit };
      if (hit && last && !last.created && now - last.t < 400 && Math.abs(p.x - last.x) < 6 && Math.abs(p.y - last.y) < 6) {
        this.lastDown = null;
        this.notes.splice(hit.i, 1);
        this.sel = -1;
        this.area.releasePointerCapture(e.pointerId);
        this.commit(true);
        return;
      }
      if (hit) {
        this.sel = hit.i;
        const n = this.notes[hit.i];
        drag = { kind: hit.edge ? "len" : "move", s0: n.s, r0: n.r, c0: c, moved: false };
      } else {
        const len = 1;
        this.notes.push({ s: c.s, r: c.r, l: len, v: this.lastVel, c: 100 });
        this.sel = this.notes.length - 1;
        drag = { kind: "len", s0: c.s, r0: c.r, c0: c, moved: true };
      }
      this.draw();
    });
    this.area.addEventListener("pointermove", (e) => {
      if (!drag) {
        const L = this.layout(), p = this.point(e), hit = p.x >= L.labelW ? this.noteAt(p.x, p.y, L) : null;
        this.svg.style.cursor = hit ? (hit.edge ? "ew-resize" : "grab") : "crosshair";
        return;
      }
      const L = this.layout(), p = this.point(e);
      if (drag.kind === "lane") { this.laneSet(p, L); return; }
      const n = this.notes[this.sel];
      if (!n) return;
      const c = this.cellAt(p.x, p.y, L);
      if (drag.kind === "len") {
        const l = Math.max(1, Math.min(this.pattern.steps - n.s, c.s - n.s + 1));
        if (l !== n.l) { n.l = l; drag.moved = true; this.draw(); }
      } else {
        const s = Math.max(0, Math.min(this.pattern.steps - n.l, drag.s0 + c.s - drag.c0.s));
        const r = Math.max(SK_ARP.rowLo, Math.min(SK_ARP.rowHi, drag.r0 + c.r - drag.c0.r));
        if (s !== n.s || r !== n.r) { n.s = s; n.r = r; drag.moved = true; this.draw(); }
      }
    });
    const end = () => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (d.kind === "lane" || d.moved) this.dedupe(), this.commit(true);
    };
    this.area.addEventListener("pointerup", end);
    this.area.addEventListener("pointercancel", end);
    this.area.addEventListener("contextmenu", (e) => {
      const p = this.point(e), hit = this.noteAt(p.x, p.y);
      if (!hit) return;
      e.preventDefault();
      this.sel = hit.i;
      this.draw();
      const n = this.notes[hit.i];
      const chance = (c) => ({ label: `${c === n.c ? "✓ " : ""}Plays ${c}% of the time`, run: () => { n.c = c; this.commit(true); } });
      this.app.menu(e.clientX, e.clientY, [
        { label: "Delete note", run: () => { this.notes.splice(hit.i, 1); this.sel = -1; this.commit(true); } },
        null, chance(100), chance(75), chance(50), chance(25),
      ]);
    });
  }
  // Two notes on the same step and row are one note.
  dedupe() {
    const keep = new Map();
    this.notes.forEach((n, i) => { const k = n.s + ":" + n.r; if (!keep.has(k) || i === this.sel) keep.set(k, i); });
    const sel = this.notes[this.sel];
    this.notes = [...keep.values()].sort((a, b) => a - b).map((i) => this.notes[i]);
    this.sel = sel ? this.notes.indexOf(sel) : -1;
  }
  // The lower lane: the selected note if it's on that step, else every note there.
  laneSet(p, L) {
    const s = Math.max(0, Math.min(this.pattern.steps - 1, Math.floor((p.x - L.labelW) / L.stepW)));
    const val = Math.max(0, Math.min(1, 1 - (p.y - L.laneTop) / L.laneH));
    const sel = this.notes[this.sel];
    const targets = sel && sel.s === s ? [sel] : this.notes.filter((n) => n.s === s);
    for (const n of targets) {
      if (this.lane === "vel") { n.v = Math.max(1, Math.round(val * 127)); this.lastVel = n.v; }
      else n.c = Math.round(val * 20) * 5;
    }
    if (targets.length) this.draw();
  }
  bindKeys() {
    this.area.addEventListener("keydown", (e) => {
      const n = this.notes[this.sel];
      if (e.key === "Delete" || e.key === "Backspace") {
        if (!n) return;
        e.preventDefault(); e.stopPropagation();
        this.notes.splice(this.sel, 1); this.sel = -1; this.commit(true);
        return;
      }
      if (e.key === "," || e.key === ".") {
        if (!this.notes.length) return;
        e.preventDefault(); e.stopPropagation();
        const order = [...this.notes.keys()].sort((a, b) => this.notes[a].s - this.notes[b].s || this.notes[a].r - this.notes[b].r);
        const at = order.indexOf(this.sel);
        this.sel = order[(at + (e.key === "." ? 1 : order.length - 1) + (at < 0 ? 1 : 0)) % order.length];
        this.draw();
        return;
      }
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
      if (!d || !n) return;
      e.preventDefault(); e.stopPropagation();
      if (e.shiftKey && d[0]) n.l = Math.max(1, Math.min(this.pattern.steps - n.s, n.l + d[0]));
      else {
        n.s = Math.max(0, Math.min(this.pattern.steps - n.l, n.s + d[0]));
        n.r = Math.max(SK_ARP.rowLo, Math.min(SK_ARP.rowHi, n.r + d[1]));
      }
      this.dedupe();
      this.commit(true);
    });
  }

  // Generator -------------------------------------------------------------------------
  // Sliders for the kit's pattern generator (API.md §4b). "New idea" draws a
  // pattern from a new seed; after that, moving a slider redraws it from the
  // same seed, until the pattern is edited by hand. Undo brings back what was
  // there before.
  buildGen() {
    this.genKey = `synthkit:${this.m.info.synth.id}:arpgen`;
    const saved = skStore.get(this.genKey, {}) || {};
    this.genSettings = { density: 0.6, range: 5, leaps: 0.3, repetition: 0.6, ties: 0.2, chords: 0, seed: 1, ...saved };
    const specs = [
      ["density", "Density", 0, 1, 0.01, "How many steps play. Low keeps the strong beats; high fills in between."],
      ["range", "Range", 2, 12, 1, "How many chord tones the line spans (with three held notes, 4 reaches the octave)."],
      ["leaps", "Leaps", 0, 1, 0.01, "Jumps rather than steps between chord tones. A leap is followed by a step back."],
      ["repetition", "Repetition", 0, 1, 0.01, "Short motifs that repeat (AABA) or keep changing (ABCD)."],
      ["ties", "Ties", 0, 1, 0.01, "Notes held into the rests after them."],
      ["chords", "Chords", 0, 1, 0.01, "A second chord tone on strong steps."],
    ];
    this.genInputs = {};
    const sliders = specs.map(([k, label, min, max, step, info]) => {
      const input = h("input", { type: "range", min, max, step, value: this.genSettings[k], "aria-label": label,
        oninput: () => { this.genSettings[k] = Number(input.value); this.saveGen(); if (this.genLive) this.generate(false); } });
      this.genInputs[k] = input;
      const name = h("span", { class: "arp-label", text: label });
      name.append(skInfoButton(info, label));
      return h("div", { class: "arp-gen-field" }, name, input);
    });
    this.seedOut = h("span", { class: "arp-gen-seed" });
    this.undoBtn = h("button", { type: "button", class: "btn btn-small btn-quiet", disabled: true, onclick: () => this.undoGen() }, "Undo");
    const idea = h("button", { type: "button", class: "btn btn-small arp-gen-go", onclick: () => this.generate(true) }, "New idea");
    this.gen = h("div", { class: "arp-gen", hidden: true }, h("div", { class: "arp-gen-sliders" }, ...sliders),
      h("div", { class: "arp-gen-actions" }, idea, this.undoBtn, this.seedOut));
    this.syncGen();
  }
  toggleGen() {
    this.gen.hidden = !this.gen.hidden;
    this.genBtn.setAttribute("aria-expanded", String(!this.gen.hidden));
  }
  saveGen() { skStore.set(this.genKey, this.genSettings); }
  syncGen() {
    this.seedOut.textContent = this.genLive ? `Idea #${this.genSettings.seed}: the sliders reshape it` : "";
    this.undoBtn.disabled = !this.undo;
  }
  generate(fresh) {
    if (fresh) {
      this.genSettings.seed = 1 + Math.floor(Math.random() * 999999);
      this.saveGen();
      // Undo returns to the pattern from before this run of ideas.
      if (!this.genLive) this.undo = { steps: this.pattern.steps, notes: this.notes.map((n) => ({ ...n })) };
    }
    // What rows mean: chord tones, semitones or scale steps (API.md §4b).
    const kind = this.isSeq() ? (this.scaled() ? 2 : 1) : 0;
    const p = this.m.arpGenerate({ ...this.genSettings, steps: this.pattern.steps, kind });
    if (!p || !Array.isArray(p.notes)) return;
    this.notes = p.notes.map((n) => ({ s: n[0], r: n[1], l: n[2], v: n[3], c: n[4] === undefined ? 100 : n[4] }));
    this.sel = -1;
    this.commit();
    this.genLive = true;
    this.syncGen();
  }
  undoGen() {
    if (!this.undo) return;
    this.pattern.steps = this.undo.steps;
    this.notes = this.undo.notes.map((n) => ({ ...n }));
    this.undo = null;
    this.genLive = false;
    this.sel = -1;
    this.commit();
    this.syncBar();
    this.syncGen();
  }

  toolsMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    const steps = this.pattern.steps;
    const edit = (fn) => () => { fn(); this.sel = -1; this.dedupe(); this.commit(true); };
    this.app.menu(r.left, r.bottom + 4, [
      { label: "Clear", run: edit(() => { this.notes = []; }) },
      { label: "Copy pattern", run: () => { skArpClipboard = { steps, notes: this.notes.map((n) => ({ ...n })) }; this.app.toast("Pattern copied"); } },
      { label: "Paste pattern", disabled: !skArpClipboard, run: edit(() => { this.pattern.steps = skArpClipboard.steps; this.notes = skArpClipboard.notes.map((n) => ({ ...n })); this.syncBar(); }) },
      null,
      { label: "Shift left a step", run: edit(() => { for (const n of this.notes) n.s = (n.s + steps - 1) % steps; this.clampLengths(); }) },
      { label: "Shift right a step", run: edit(() => { for (const n of this.notes) n.s = (n.s + 1) % steps; this.clampLengths(); }) },
      { label: "Up a chord tone", run: edit(() => { for (const n of this.notes) n.r = Math.min(SK_ARP.rowHi, n.r + 1); }) },
      { label: "Down a chord tone", run: edit(() => { for (const n of this.notes) n.r = Math.max(SK_ARP.rowLo, n.r - 1); }) },
      { label: "Reverse", run: edit(() => { for (const n of this.notes) n.s = steps - n.s - n.l; }) },
      { label: "Flip upside down", run: edit(() => {
        if (!this.notes.length) return;
        const lo = Math.min(...this.notes.map((n) => n.r)), hi = Math.max(...this.notes.map((n) => n.r));
        for (const n of this.notes) n.r = lo + hi - n.r;
      }) },
      { label: "Repeat to double length", disabled: steps * 2 > SK_ARP.maxSteps, run: edit(() => {
        this.notes = this.notes.concat(this.notes.map((n) => ({ ...n, s: n.s + steps })));
        this.pattern.steps = steps * 2;
        this.syncBar();
      }) },
    ]);
  }
  clampLengths() { for (const n of this.notes) n.l = Math.max(1, Math.min(n.l, this.pattern.steps - n.s)); }
}
