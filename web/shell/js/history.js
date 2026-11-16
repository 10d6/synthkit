// Undo and redo for the sound: parameters, modulation routes, shapes, custom
// state, the patch's tempo and whole patch loads (picking a preset can be
// undone too). Changes from the plugin's host (automation, the DAW's own
// controls) and mapped MIDI controllers aren't recorded.
//
// Changes are grouped into steps: a drag is one step (from model.gesture or
// begin/end), batch(label, fn) makes one step of everything fn changes, and
// quick repeats on the same thing (wheel ticks, arrow keys) merge into one.
// Each step also keeps which preset was showing and whether the sound had
// changed since it was loaded, so undoing back to a saved sound clears the
// preset bar's "changed" dot again.

const SK_MERGE_MS = 700;

class SkHistory {
  constructor(model, { limit = 200 } = {}) {
    this.m = model;
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
    this.gestures = new Set();    // open drags (tokens)
    this.batchDepth = 0;
    this.batchLabel = "";
    this.openEntry = null;        // the step a drag or batch is filling
    this.applying = false;        // undo/redo is changing the model
    this.listeners = new Set();
    this.uiState = null;          // () => ({ current, dirty }) (the preset bar)
    this.onRestore = null;        // (ui) after an undo or redo
    // A drag whose end was missed (the pointer left the window, say) mustn't
    // swallow every later change into one step.
    const settle = () => setTimeout(() => { if (this.gestures.size) { this.gestures.clear(); this.closeOpen(); } }, 0);
    window.addEventListener("pointerup", settle);
    window.addEventListener("pointercancel", settle);
    window.addEventListener("blur", settle);
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get undoLabel() { const e = this.undoStack[this.undoStack.length - 1]; return e ? e.label : ""; }
  get redoLabel() { const e = this.redoStack[this.redoStack.length - 1]; return e ? e.label : ""; }
  state() { return { canUndo: this.canUndo, canRedo: this.canRedo, undoLabel: this.undoLabel, redoLabel: this.redoLabel }; }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { const s = this.state(); for (const fn of this.listeners) { try { fn(s); } catch (err) { console.error(err); } } }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
    this.openEntry = null;
    this.emit();
  }

  // ---- grouping ---------------------------------------------------------------

  begin(token) { if (!this.gestures.size && !this.batchDepth) this.closeOpen(); this.gestures.add(token); }
  end(token) {
    if (!this.gestures.delete(token)) return;
    if (!this.gestures.size && !this.batchDepth) this.closeOpen();
  }
  // Everything fn changes becomes one step, called label ("Reset LFO 1").
  batch(label, fn) {
    if (!this.batchDepth && !this.gestures.size) { this.closeOpen(); this.batchLabel = label || ""; }
    this.batchDepth++;
    try { return fn(); }
    finally { if (--this.batchDepth === 0 && !this.gestures.size) this.closeOpen(); }
  }
  closeOpen() {
    if (this.openEntry) this.openEntry.merge = false;
    this.openEntry = null;
    if (!this.batchDepth) this.batchLabel = "";
  }

  // ---- recording (called by the model) -------------------------------------------

  // kind: "p" (parameter i), "mod", "shapes", "custom" (id), "tempo", "patch".
  record(kind, from, to, extra = {}) {
    if (this.applying) return;
    const key = kind === "p" ? "p:" + extra.i : kind === "custom" ? "custom:" + extra.id : kind;
    const grouped = this.gestures.size > 0 || this.batchDepth > 0;
    const now = performance.now();
    const top = this.undoStack[this.undoStack.length - 1];
    let e = null;
    if (grouped && this.openEntry && this.openEntry === top) e = this.openEntry;
    else if (!grouped && top && top.merge && top.key === key && now - top.time < SK_MERGE_MS && !this.redoStack.length) e = top;
    if (!e) {
      if (top) this.close(top);
      e = { label: (grouped && this.batchLabel) || extra.label || this.describe(kind, extra), key, changes: [], time: now,
            merge: !grouped && kind !== "patch", uiBefore: this.ui(), uiAfter: null };
      this.undoStack.push(e);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
      this.redoStack = [];
      if (grouped) this.openEntry = e;
    }
    e.time = now;
    const c = e.changes.find((x) => x.key === key);
    if (c) c.to = to;
    else e.changes.push({ kind, key, from, to, ...extra });
    if (e.changes.length > 1) e.key = "";   // a mixed step never merges
    this.emit();
  }

  describe(kind, extra) {
    if (kind === "p") { const p = this.m.param(extra.i); return p ? p.name : "change"; }
    if (kind === "mod") return "modulation";
    if (kind === "shapes") return "shape";
    if (kind === "custom") return extra.id === "sk.arp" || extra.id === "sk.seq" ? "pattern" : extra.id;
    if (kind === "tempo") return "tempo";
    if (kind === "patch") return "preset change";
    return kind;
  }

  ui() { return this.uiState ? this.uiState() : null; }
  close(e) { if (!e.uiAfter) e.uiAfter = this.ui(); }

  // ---- undo / redo ----------------------------------------------------------------

  undo() {
    if (this.gestures.size || this.batchDepth) return false;
    const e = this.undoStack.pop();
    if (!e) return false;
    this.close(e);
    e.merge = false;
    this.openEntry = null;
    this.apply(e, "from");
    this.redoStack.push(e);
    this.restore(e.uiBefore);
    return true;
  }
  redo() {
    if (this.gestures.size || this.batchDepth) return false;
    const e = this.redoStack.pop();
    if (!e) return false;
    this.apply(e, "to");
    this.undoStack.push(e);
    this.restore(e.uiAfter);
    return true;
  }

  apply(e, side) {
    const list = side === "from" ? [...e.changes].reverse() : e.changes;
    this.applying = true;
    try {
      for (const c of list) {
        const v = c[side];
        if (c.kind === "p") this.m.set(c.i, v, "history");
        else if (c.kind === "mod") this.m.setRoutes(v);
        else if (c.kind === "shapes") this.m.setShapes(v);
        else if (c.kind === "custom") this.m.setCustom(c.id, v);
        else if (c.kind === "tempo") { if (v) this.m.setPatchTempo(v.bpm, v.num, v.den); }
        else if (c.kind === "patch") this.m.loadPatch(v);
      }
    } catch (err) {
      console.error(err);
    } finally {
      this.applying = false;
    }
  }

  restore(ui) {
    if (this.onRestore) { try { this.onRestore(ui); } catch (err) { console.error(err); } }
    this.emit();
  }

  // ---- keeping the preset bar's state right --------------------------------------

  // The current sound was just saved as ui.current: steps since the last
  // preset change now lead to or from that saved sound.
  saved(current) {
    const cur = () => ({ ...current });
    const hasPatch = (e) => e.changes.some((c) => c.kind === "patch");
    const u = this.undoStack;
    if (u.length) u[u.length - 1].merge = false;
    for (let k = u.length - 1; k >= 0; k--) {
      const e = u[k];
      this.close(e);
      e.uiAfter = { current: cur(), dirty: k !== u.length - 1 };
      if (hasPatch(e)) break;
      e.uiBefore = { current: cur(), dirty: true };
    }
    const r = this.redoStack;
    for (let k = r.length - 1; k >= 0; k--) {
      const e = r[k];
      e.uiBefore = { current: cur(), dirty: k !== r.length - 1 };
      if (hasPatch(e)) break;
      e.uiAfter = { current: cur(), dirty: true };
    }
  }

  // A preset was renamed (to = { kind, name }) or deleted (to = { kind: "session", … }).
  renamed(from, to) {
    const fix = (ui) => { if (ui && ui.current && ui.current.kind === from.kind && ui.current.name === from.name) ui.current = { ...to }; };
    for (const e of [...this.undoStack, ...this.redoStack]) { fix(e.uiBefore); fix(e.uiAfter); }
  }
}

// Undo/redo buttons (the header's, or mounted on a synth's own page as "undo").
function skUndoButtons(app) {
  const hist = app.model.history;
  const icon = (flip) => {
    const s = svg("svg", { viewBox: "0 0 16 16", width: 16, height: 16, "aria-hidden": "true", class: "undo-icon" + (flip ? " is-redo" : "") });
    s.append(svg("path", { d: "M5.5 3.5 2.5 6.5 5.5 9.5", fill: "none", stroke: "currentColor", "stroke-width": 1.5, "stroke-linecap": "round", "stroke-linejoin": "round" }),
             svg("path", { d: "M3 6.5h6.25a3.75 3.75 0 0 1 0 7.5H7", fill: "none", stroke: "currentColor", "stroke-width": 1.5, "stroke-linecap": "round" }));
    return s;
  };
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const mod = mac ? "⌘" : "Ctrl+";
  const undo = h("button", { type: "button", class: "btn btn-quiet btn-icon undo-btn", onclick: () => hist.undo() }, icon(false));
  const redo = h("button", { type: "button", class: "btn btn-quiet btn-icon redo-btn", onclick: () => hist.redo() }, icon(true));
  const sync = (s) => {
    undo.disabled = !s.canUndo;
    redo.disabled = !s.canRedo;
    const u = s.canUndo ? `Undo ${s.undoLabel}` : "Nothing to undo";
    const r = s.canRedo ? `Redo ${s.redoLabel}` : "Nothing to redo";
    undo.title = `${u} (${mod}Z)`; undo.setAttribute("aria-label", u);
    redo.title = `${r} (${mac ? "⇧⌘Z" : "Ctrl+Y"})`; redo.setAttribute("aria-label", r);
  };
  hist.onChange(sync);
  sync(hist.state());
  return h("div", { class: "undo", role: "group", "aria-label": "Undo and redo" }, undo, redo);
}
