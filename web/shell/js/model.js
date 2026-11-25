// The page's copy of the engine. It never makes sound: it holds the current
// parameter values, formats and parses them exactly like the plugin will,
// and saves/loads patches. Changes are forwarded to the audio thread.

class Model {
  // quiet: a second copy for reading other states (the panels' reset
  // buttons), whose messages would only repeat the main one's.
  static async create(bytes, { quiet = false } = {}) {
    let memory = null;
    const logs = [];
    const { instance } = await WebAssembly.instantiate(bytes, skImports(() => memory, (m) => { if (quiet) return; logs.push(m); console.error("[synth]", m); }));
    memory = instance.exports.memory;
    return new Model(new SkWasm(instance), logs);
  }

  constructor(w, logs) {
    this.w = w;
    this.x = w.x;
    this.logs = logs;
    this.info = w.json(this.x.sk_info());
    this.params = this.info.params.map((p, i) => ({ ...p, index: i }));
    this.byId = new Map(this.params.map((p) => [p.id, p]));
    this.listeners = new Map();   // index -> Set(fn)
    this.anyListeners = new Set();
    this.customListeners = new Map();
    this.sink = null;             // audio forwarding: {param(i, v), gesture?(i, on), patch(json), custom(id, json), mod(json), shapes(json)}
    this.mod = this.info.mod || { sources: [], slots: 0, lfos: 0, shapes: 0 };
    this.sourceIndex = new Map(this.mod.sources.map((s, i) => [s.id, i]));
    this.modListeners = new Set();
    this.shapeListeners = new Set();
    this.dirty = false;
    this.patchListeners = new Set();   // after any patch load
    this.history = null;               // SkHistory (history.js), set by the app
  }

  param(id) { return typeof id === "number" ? this.params[id] : this.byId.get(id); }
  get(id) { const p = this.param(id); return p ? this.x.sk_get_param(p.index) : NaN; }
  norm(id) { const p = this.param(id); return this.x.sk_to_norm(p.index, this.get(p.index)); }
  toNorm(id, v) { return this.x.sk_to_norm(this.param(id).index, v); }
  fromNorm(id, n) { return this.x.sk_from_norm(this.param(id).index, n); }
  format(id, v) { const p = this.param(id); return this.w.str(this.x.sk_format(p.index, v === undefined ? this.get(p.index) : v)); }
  parse(id, text) {
    const p = this.param(id);
    const v = this.w.withStrings([text], (t) => this.x.sk_parse(p.index, t));
    return Number.isNaN(v) ? null : v;
  }

  set(id, v, source) {
    const p = this.param(id);
    if (!p) return;
    const before = this.get(p.index);
    this.x.sk_set_param(p.index, v);
    const now = this.get(p.index);
    if (now === before) return;
    if (this.history) this.history.record("p", before, now, { i: p.index });
    this.dirty = true;
    if (this.sink) this.sink.param(p.index, now);
    this.emit(p.index, now, source);
  }
  setNorm(id, n, source) { this.set(id, this.fromNorm(id, Math.min(1, Math.max(0, n))), source); }
  // A value that changed in the plugin (automation, the host's own controls):
  // update the page without sending it back.
  applyHost(i, v) {
    const p = this.param(i);
    if (!p) return;
    const before = this.get(p.index);
    this.x.sk_set_param(p.index, v);
    const now = this.get(p.index);
    if (now !== before) { this.dirty = true; this.emit(p.index, now, "host"); }
  }
  // Start/end of a drag, so a DAW records the change as one gesture.
  gesture(id, on) {
    const p = this.param(id);
    if (!p) return;
    if (this.history) { if (on) this.history.begin("p:" + p.index); else this.history.end("p:" + p.index); }
    if (this.sink && this.sink.gesture) this.sink.gesture(p.index, on);
  }
  reset(id) { const p = this.param(id); this.set(p.index, p.def); }

  on(id, fn) {
    const p = this.param(id);
    if (!p) return () => {};
    if (!this.listeners.has(p.index)) this.listeners.set(p.index, new Set());
    this.listeners.get(p.index).add(fn);
    return () => this.listeners.get(p.index).delete(fn);
  }
  onAny(fn) { this.anyListeners.add(fn); return () => this.anyListeners.delete(fn); }
  emit(i, v, source) {
    for (const fn of this.listeners.get(i) || []) fn(v, source);
    for (const fn of this.anyListeners) fn(i, v, source);
  }
  emitAll() { this.params.forEach((p) => this.emit(p.index, this.get(p.index), "patch")); }

  // Patches ----------------------------------------------------------------
  savePatch() { return JSON.parse(this.w.str(this.x.sk_save_patch())); }
  get patchName() { return this.savePatch().name; }
  setName(name) { this.w.withStrings([name], (p) => this.x.sk_set_name(p)); }
  get patchCategory() { return this.savePatch().category || ""; }
  setCategory(category) { this.w.withStrings([category || ""], (p) => this.x.sk_set_category(p)); }

  // fromHost: the plugin already has this patch, so don't send it back.
  loadPatch(patch, { fromHost = false } = {}) {
    const text = typeof patch === "string" ? patch : JSON.stringify(patch);
    const prev = this.history && !fromHost ? this.savePatch() : null;
    const res = this.w.json(this.w.withStrings([text], (p) => this.x.sk_load_patch(p)));
    if (!res.ok) return res;
    const saved = JSON.stringify(this.savePatch());
    if (prev) this.history.record("patch", prev, JSON.parse(saved), { label: `loading “${JSON.parse(saved).name || "patch"}”` });
    if (this.sink && !fromHost) this.sink.patch(saved);
    this.dirty = false;
    this.emitAll();
    for (const id of this.info.custom) this.emitCustom(id);
    this.emitMod();
    this.emitShapes();
    for (const fn of this.patchListeners) { try { fn(); } catch (err) { console.error(err); } }
    return res;
  }
  onPatch(fn) { this.patchListeners.add(fn); return () => this.patchListeners.delete(fn); }

  // The patch's tempo (features.tempoInPatch): {bpm, num, den}, or null.
  patchTempo() { const t = this.w.str(this.x.sk_patch_tempo()); return t ? JSON.parse(t) : null; }
  setPatchTempo(bpm, num, den) {
    const t = this.patchTempo();
    if (t && t.bpm === bpm && t.num === num && t.den === den) return;
    this.x.sk_set_patch_tempo(bpm, num, den);
    if (this.history) this.history.record("tempo", t, { bpm, num, den });
    this.dirty = true;
    for (const fn of this.anyListeners) fn(-1, 0, "tempo");
  }

  // Modulation -------------------------------------------------------------
  routes() { return this.mod.slots ? this.w.json(this.x.sk_get_mod()) : []; }
  setRoutes(routes) {
    const before = this.history ? this.routes() : null;
    const warnings = this.w.json(this.w.withStrings([JSON.stringify(routes)], (p) => this.x.sk_set_mod(p)));
    if (before) { const after = this.routes(); if (JSON.stringify(after) !== JSON.stringify(before)) this.history.record("mod", before, after); }
    this.dirty = true;
    if (this.sink) this.sink.mod(JSON.stringify(this.routes()));
    this.emitMod();
    for (const fn of this.anyListeners) fn(-1, 0, "mod");
    return warnings;
  }
  onMod(fn) { this.modListeners.add(fn); return () => this.modListeners.delete(fn); }
  emitMod() { const r = this.routes(); for (const fn of this.modListeners) fn(r); }
  modulatable() { return this.params.filter((p) => p.modulatable); }

  shapes() { return this.mod.shapes ? this.w.json(this.x.sk_get_shapes()) : []; }
  setShapes(shapes, quiet) {
    const before = this.history ? this.shapes() : null;
    this.w.withStrings([JSON.stringify(shapes)], (p) => this.x.sk_set_shapes(p));
    if (before) { const after = this.shapes(); if (JSON.stringify(after) !== JSON.stringify(before)) this.history.record("shapes", before, after); }
    this.dirty = true;
    if (this.sink) this.sink.shapes(JSON.stringify(shapes));
    if (!quiet) this.emitShapes();
    for (const fn of this.anyListeners) fn(-1, 0, "shapes");
  }
  onShapes(fn) { this.shapeListeners.add(fn); return () => this.shapeListeners.delete(fn); }
  emitShapes() { const s = this.shapes(); for (const fn of this.shapeListeners) fn(s); }

  // The arpeggiator's pattern generator (API.md §4b): settings in, one pattern out.
  arpGenerate(settings = {}) { return this.w.json(this.w.withStrings([JSON.stringify(settings)], (p) => this.x.sk_arp_generate(p))); }

  // Custom state -----------------------------------------------------------
  custom(id) { return this.w.json(this.w.withStrings([id], (p) => this.x.sk_get_custom(p))); }
  setCustom(id, value) {
    const json = JSON.stringify(value);
    const before = this.history ? this.custom(id) : null;
    const ok = this.w.withStrings([id, json], (a, b) => this.x.sk_set_custom(a, b));
    if (!ok) return false;
    if (this.history) { const after = this.custom(id); if (JSON.stringify(after) !== JSON.stringify(before)) this.history.record("custom", before, after, { id }); }
    this.dirty = true;
    if (this.sink) this.sink.custom(id, JSON.stringify(this.custom(id)));
    this.emitCustom(id);
    return true;
  }
  onCustom(id, fn) {
    if (!this.customListeners.has(id)) this.customListeners.set(id, new Set());
    this.customListeners.get(id).add(fn);
    return () => this.customListeners.get(id).delete(fn);
  }
  emitCustom(id) { const v = this.custom(id); for (const fn of this.customListeners.get(id) || []) fn(v); }
  customSnapshot() {
    const o = {};
    for (const id of this.info.custom) o[id] = JSON.stringify(this.custom(id));
    return o;
  }
}
