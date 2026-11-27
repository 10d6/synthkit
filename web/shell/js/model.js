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
    this.lastEdited = -1;
    this.partParamListeners = new Map();   // "part:index" -> Set(fn): one part's parameter, selected or not
    this.nameListeners = new Set();        // (part) after a part's patch was renamed
    this.customListeners = new Map();
    this.sink = null;             // audio forwarding: {param(i, v), gesture?(i, on), patch(json), custom(id, json), mod(json), shapes(json)}
    this.mod = this.info.mod || { sources: [], slots: 0, lfos: 0, shapes: 0 };
    this.sourceIndex = new Map(this.mod.sources.map((s, i) => [s.id, i]));
    this.modListeners = new Set();
    this.shapeListeners = new Set();
    this.dirtyParts = [];              // "changed since loaded", per part (the bar shows the selected part's)
    this.multi = !!this.info.synth.multi;      // the synth can be played as a Multi (API.md §5b)
    this.maxParts = this.info.synth.maxParts || 1;
    this.part = 0;                     // the part everything below edits
    this.partListeners = new Set();    // (part) after another part is selected
    this.layoutListeners = new Set();  // (layout) after the layout changed
    this.patchListeners = new Set();   // after any patch load
    this.history = null;               // SkHistory (history.js), set by the app
  }

  get dirty() { return !!this.dirtyParts[this.part]; }
  // A change to the selected part (a control, the mod matrix, custom state…)
  // also makes it the last part edited.
  set dirty(v) { this.dirtyParts[this.part] = !!v; if (v) this.edited(this.part); }
  // The part last changed by hand (Layers and splits selects its zone first);
  // -1 when nothing has been, since the sound loaded.
  edited(part) { this.lastEdited = part; }

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
    if (this.history) this.history.record("p", before, now, { i: p.index });   // (the history adds the part)
    this.dirty = true;
    if (this.sink) this.sink.param(p.index, now);
    this.emit(p.index, now, source);
  }
  setNorm(id, n, source) { this.set(id, this.fromNorm(id, Math.min(1, Math.max(0, n))), source); }
  // The same for another part of a multi.
  applyHostPart(part, i, v) {
    if (!part || part === this.part) return this.applyHost(i, v);
    const before = this.x.sk_get_param_of(part, i);
    this.x.sk_select_part(part);
    this.x.sk_set_param(i, v);
    this.x.sk_select_part(this.part);
    const now = this.x.sk_get_param_of(part, i);
    if (now !== before) { this.dirtyParts[part] = true; this.emitIn(part, i, now, "host"); }
  }
  // A value that changed in the plugin (automation, the host's own controls):
  // update the page without sending it back.
  applyHost(i, v) {
    const p = this.param(i);
    if (!p) return;
    const before = this.get(p.index);
    this.x.sk_set_param(p.index, v);
    const now = this.get(p.index);
    if (now !== before) { this.dirtyParts[this.part] = true; this.emit(p.index, now, "host"); }
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
    this.emitIn(this.part, i, v, source);
  }

  // ---- any part, without selecting it (the rack's voice strips) -------------------
  // For a synth without multis, part 0 is the only one and these are the
  // plain calls above.
  getIn(part, id) {
    const p = this.param(id);
    if (!p) return NaN;
    return !this.multi || part === this.part ? this.get(p.index) : this.x.sk_get_param_of(part, p.index);
  }
  setIn(part, id, v, source) {
    const p = this.param(id);
    if (!p) return;
    if (!this.multi || part === this.part) return this.set(p.index, v, source);
    const before = this.getIn(part, p.index);
    this.x.sk_select_part(part);
    this.x.sk_set_param(p.index, v);
    this.x.sk_select_part(this.part);
    const now = this.getIn(part, p.index);
    if (now === before) return;
    if (this.history) this.history.record("p", before, now, { i: p.index, part, strip: true });
    this.dirtyParts[part] = true;
    this.edited(part);
    if (this.sink && this.sink.paramAt) this.sink.paramAt(part, p.index, now);
    this.emitIn(part, p.index, now, source);
    for (const fn of this.anyListeners) fn(-1, 0, "part");   // (something changed: the sound bar's "changed" dot)
  }
  gestureIn(part, id, on) {
    if (!this.multi || part === this.part) return this.gesture(id, on);
    const p = this.param(id);
    if (!p) return;
    if (this.history) { if (on) this.history.begin(`p:${part}:${p.index}`); else this.history.end(`p:${part}:${p.index}`); }
    if (this.sink && this.sink.gestureAt) this.sink.gestureAt(part, p.index, on);
  }
  onIn(part, id, fn) {
    const p = this.param(id);
    if (!p) return () => {};
    const key = part + ":" + p.index;
    if (!this.partParamListeners.has(key)) this.partParamListeners.set(key, new Set());
    this.partParamListeners.get(key).add(fn);
    return () => { const set = this.partParamListeners.get(key); if (set) set.delete(fn); };
  }
  emitIn(part, i, v, source) {
    for (const fn of this.partParamListeners.get(part + ":" + i) || []) { try { fn(v, source); } catch (err) { console.error(err); } }
  }
  // Every part's listeners, after something replaced several parts' values.
  emitParts() {
    const parts = this.multi ? this.maxParts : 1;
    for (const key of this.partParamListeners.keys()) {
      const [part, i] = key.split(":").map(Number);
      if (part < parts) this.emitIn(part, i, this.getIn(part, i), "patch");
    }
    for (let p = 0; p < parts; p++) this.emitName(p);
  }

  // A part's patch name (the voice's name in the rack).
  nameOf(part) {
    if (!this.multi || part === this.part) return this.savePatch().name || "";
    const n = this.partNames()[part];
    return (n && n.name) || "";
  }
  setNameIn(part, name) {
    const before = this.nameOf(part);
    if (name === before) return;
    if (!this.multi || part === this.part) this.setName(name);
    else { this.x.sk_select_part(part); this.setName(name); this.x.sk_select_part(this.part); }
    if (this.history) this.history.record("name", before, name, { part, label: "renaming the voice" });
    this.dirtyParts[part] = true;
    this.edited(part);
    if (this.sink && this.sink.name) this.sink.name(part, name);
    this.emitName(part);
    for (const fn of this.anyListeners) fn(-1, 0, "part");
  }
  onName(fn) { this.nameListeners.add(fn); return () => this.nameListeners.delete(fn); }
  emitName(part) { for (const fn of this.nameListeners) { try { fn(part); } catch (err) { console.error(err); } } }
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
    this.emitName(this.part);
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

  // Multis (API.md §5b) ------------------------------------------------------
  // The page edits one part at a time: selecting a part points everything
  // above (parameters, patches, modulation, custom state) at it.
  selectPart(i, { quiet = false } = {}) {
    if (!this.multi) return 0;
    i = Math.max(0, Math.min(this.maxParts - 1, Math.round(i)));
    if (i === this.part && !quiet) return i;
    this.part = this.x.sk_select_part(i);
    if (this.sink && this.sink.select) this.sink.select(this.part);
    this.emitAll();
    for (const id of this.info.custom) this.emitCustom(id);
    this.emitMod();
    this.emitShapes();
    for (const fn of this.patchListeners) { try { fn(); } catch (err) { console.error(err); } }
    for (const fn of this.partListeners) { try { fn(this.part); } catch (err) { console.error(err); } }
    return this.part;
  }
  onPart(fn) { this.partListeners.add(fn); return () => this.partListeners.delete(fn); }

  // [{name, category}] for every part (the unused ones hold the default patch).
  partNames() { return this.multi ? this.w.json(this.x.sk_part_names()) : []; }

  layout() { return this.multi ? this.w.json(this.x.sk_multi_layout()) : { parts: [{}], zones: [] }; }
  // Sets the layout (see Multi::layoutJson in the API). Returns what was dropped.
  // record: false leaves it out of undo and doesn't mark the multi changed
  // (the page's own "ui" state, like whether Layers and splits is open).
  setLayout(layout, { fromHost = false, record = true } = {}) {
    const before = this.history && !fromHost && record ? this.layout() : null;
    const warnings = this.w.json(this.w.withStrings([JSON.stringify(layout)], (p) => this.x.sk_set_multi_layout(p)));
    const after = this.layout();
    if (before && JSON.stringify(before) !== JSON.stringify(after)) this.history.record("layout", before, after);
    if (!fromHost) { if (record) this.multiDirty = true; if (this.sink && this.sink.layout) this.sink.layout(JSON.stringify(after)); }
    // A selected part that's no longer in use.
    if (this.part >= after.parts.length) this.selectPart(after.parts.length - 1);
    for (const fn of this.layoutListeners) { try { fn(after); } catch (err) { console.error(err); } }
    return warnings;
  }
  onLayout(fn) { this.layoutListeners.add(fn); return () => this.layoutListeners.delete(fn); }

  multiSave(name = "") { return JSON.parse(this.w.str(this.w.withStrings([name], (p) => this.x.sk_multi_save(p)))); }
  // Loads a whole multi: every part's patch and the layout.
  loadMulti(multi, { fromHost = false, label = "" } = {}) {
    const text = typeof multi === "string" ? multi : JSON.stringify(multi);
    const prev = this.history && !fromHost ? this.multiSave() : null;
    const res = this.w.json(this.w.withStrings([text], (p) => this.x.sk_multi_load(p)));
    if (!res.ok) return res;
    const saved = this.multiSave();
    if (prev) this.history.record("multi", prev, saved, { label: label || `loading multi “${saved.name || "multi"}”` });
    if (this.sink && !fromHost && this.sink.multi) this.sink.multi(JSON.stringify(saved));
    this.dirtyParts = [];
    this.multiDirty = false;
    this.lastEdited = -1;
    const layout = this.layout();
    if (this.part >= layout.parts.length) this.part = this.x.sk_select_part(0);
    this.emitAll();
    for (const id of this.info.custom) this.emitCustom(id);
    this.emitMod();
    this.emitShapes();
    for (const fn of this.patchListeners) { try { fn(); } catch (err) { console.error(err); } }
    for (const fn of this.layoutListeners) { try { fn(layout); } catch (err) { console.error(err); } }
    for (const fn of this.partListeners) { try { fn(this.part); } catch (err) { console.error(err); } }
    this.emitParts();
    return res;
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
