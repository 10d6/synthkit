// Reset buttons for groups of controls (a panel: an LFO, an envelope, the
// filter…). A group is a list of parameters plus, for some kit panels, a
// shape's curve, the modulation routes or the arp/sequencer patterns.
//
// A click puts the group back to how it is in the preset that's loaded (or
// was last saved); if it already is, it resets the group to its defaults.
// Right-click offers both. When the sound isn't one of the presets, the
// saved state is the defaults.
//
// The saved and default states are read from a second, silent copy of the
// synth (the same WebAssembly module), so they come out exactly as loading
// would make them: migrations, missing values and all.

class SkResets {
  constructor(app) {
    this.app = app;
    this.m = app.model;
    this.scratch = null;
    this.defaults = null;
    this.savedKey = undefined;
    this.saved = null;
    this.buttons = new Set();
    this.queued = false;
    Model.create(app.wasm, { quiet: true }).then((s) => {
      this.scratch = s;
      this.defaults = this.snap(s);
      this.refresh();
    }).catch((err) => console.error("[synthkit] reset buttons:", err));
    const later = () => this.queue();
    this.m.onAny(later);
    this.m.onMod(later);
    this.m.onShapes(later);
    for (const id of this.m.info.custom) this.m.onCustom(id, later);
  }

  snap(model) {
    const custom = {};
    for (const id of model.info.custom) custom[id] = model.custom(id);
    return { params: model.params.map((p) => model.get(p.index)), routes: model.routes(), shapes: model.shapes(), custom };
  }

  // The state of the preset that's loaded, or null.
  savedState() {
    const pr = this.app.presets;
    const base = pr && pr.baseline();
    const key = base ? JSON.stringify(base) : null;
    if (key === this.savedKey) return this.saved;
    this.savedKey = key;
    this.saved = null;
    if (!base || !this.scratch) return null;
    const s = this.scratch, d = this.defaults;
    // Start from the defaults, so nothing is left from the last preset read.
    if (s.mod.slots) s.setRoutes(d.routes);
    if (s.mod.shapes) s.setShapes(d.shapes, true);
    for (const id of s.info.custom) s.setCustom(id, d.custom[id]);
    const res = s.loadPatch(base);
    if (res.ok) this.saved = this.snap(s);
    return this.saved;
  }

  // group: { params: [ids], shapes: [n…], routes: true, custom: [ids] }
  differs(g, st) {
    const m = this.m;
    for (const id of g.params || []) {
      const p = m.param(id);
      if (!p) continue;
      // (Values that went through a patch's text can be a hair off.)
      const v = m.get(p.index), w = st.params[p.index];
      if (Math.abs(v - w) > 1e-5 * Math.max(1, Math.abs(w))) return true;
    }
    if (g.routes && JSON.stringify(m.routes()) !== JSON.stringify(st.routes)) return true;
    if (g.shapes && g.shapes.length) {
      const cur = m.shapes();
      for (const n of g.shapes) if (JSON.stringify(cur[n - 1]) !== JSON.stringify(st.shapes[n - 1])) return true;
    }
    for (const id of g.custom || []) if (JSON.stringify(m.custom(id)) !== JSON.stringify(st.custom[id])) return true;
    return false;
  }

  // What a click does now: { kind: "saved" | "default", state } or null.
  target(g) {
    if (!this.defaults) return null;
    const saved = this.savedState();
    if (saved && this.differs(g, saved)) return { kind: "saved", state: saved };
    if (this.differs(g, this.defaults)) return { kind: "default", state: this.defaults };
    return null;
  }

  apply(g, st, label) {
    const m = this.m;
    const run = () => {
      for (const id of g.params || []) { const p = m.param(id); if (p) m.set(p.index, st.params[p.index], "ui"); }
      if (g.routes && JSON.stringify(m.routes()) !== JSON.stringify(st.routes)) m.setRoutes(st.routes);
      if (g.shapes && g.shapes.length) {
        const cur = m.shapes();
        let changed = false;
        for (const n of g.shapes) if (JSON.stringify(cur[n - 1]) !== JSON.stringify(st.shapes[n - 1])) { cur[n - 1] = st.shapes[n - 1]; changed = true; }
        if (changed) m.setShapes(cur);
      }
      for (const id of g.custom || []) if (JSON.stringify(m.custom(id)) !== JSON.stringify(st.custom[id])) m.setCustom(id, st.custom[id]);
    };
    if (m.history) m.history.batch(label, run); else run();
  }

  presetName() { const c = this.app.presets && this.app.presets.current; return c ? c.name : ""; }

  // The button for one group; title is the panel's name. group.custom may be
  // a function (the arp pattern panel's bank depends on the mode).
  button(title, group) {
    const base = { params: [...new Set(group.params || [])], shapes: group.shapes || [], routes: !!group.routes };
    const groupNow = () => ({ ...base, custom: (typeof group.custom === "function" ? group.custom() : group.custom) || [] });
    const s = svg("svg", { viewBox: "0 0 16 16", "aria-hidden": "true" });
    s.append(svg("path", { d: "M3.2 8a4.8 4.8 0 1 0 1.5-3.5", class: "reset-arc" }), svg("path", { d: "M4.4 1.9v2.9h2.9", class: "reset-arc" }));
    const b = h("button", { type: "button", class: "reset-btn" }, s);
    b.skGroup = groupNow;
    b.skTitle = title || "these controls";
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const g = groupNow();
      const t = this.target(g);
      if (!t) return;
      this.apply(g, t.state, t.kind === "saved" ? `revert ${b.skTitle}` : `reset ${b.skTitle}`);
      this.app.toast(t.kind === "saved" ? `${b.skTitle}: back to “${this.presetName()}”` : `${b.skTitle}: back to defaults`);
    });
    b.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!this.defaults) return;
      const g = groupNow();
      const saved = this.savedState();
      this.app.menu(e.clientX, e.clientY, [
        { label: saved ? `Revert to “${this.presetName()}”` : "Revert to saved (no preset loaded)", disabled: !saved || !this.differs(g, saved),
          run: () => this.apply(g, saved, `revert ${b.skTitle}`) },
        { label: "Reset to defaults", disabled: !this.differs(g, this.defaults), run: () => this.apply(g, this.defaults, `reset ${b.skTitle}`) },
      ]);
    });
    // Letters on the button aren't notes; Ctrl/⌘ shortcuts (undo) still work.
    b.addEventListener("keydown", (e) => { if (!e.ctrlKey && !e.metaKey) e.stopPropagation(); });
    this.buttons.add(b);
    this.update(b);
    return b;
  }

  update(b) {
    const t = this.target(b.skGroup());
    b.disabled = !t;
    const what = !t ? (this.defaults ? `${b.skTitle}: nothing to reset` : `Reset ${b.skTitle}`)
      : t.kind === "saved" ? `Revert ${b.skTitle} to “${this.presetName()}”` : `Reset ${b.skTitle} to defaults`;
    b.title = what + (t ? " (right-click for both)" : "");
    b.setAttribute("aria-label", what);
  }

  queue() {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => { this.queued = false; this.refresh(); });
  }
  refresh() {
    for (const b of this.buttons) {
      if (!b.isConnected && b.skMounted) { this.buttons.delete(b); continue; }
      if (b.isConnected) b.skMounted = true;
      this.update(b);
    }
  }
}
