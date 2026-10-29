// The page's copy of the engine. It never makes sound: it holds the current
// parameter values, formats and parses them exactly like the plugin will,
// and saves/loads patches. Changes are forwarded to the audio thread.

class Model {
  static async create(bytes) {
    let memory = null;
    const logs = [];
    const { instance } = await WebAssembly.instantiate(bytes, skImports(() => memory, (m) => { logs.push(m); console.error("[synth]", m); }));
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
    this.sink = null;             // audio forwarding: {param(i, v), patch(json), custom(id, json)}
    this.dirty = false;
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
    this.dirty = true;
    if (this.sink) this.sink.param(p.index, now);
    this.emit(p.index, now, source);
  }
  setNorm(id, n, source) { this.set(id, this.fromNorm(id, Math.min(1, Math.max(0, n))), source); }
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

  loadPatch(patch) {
    const text = typeof patch === "string" ? patch : JSON.stringify(patch);
    const res = this.w.json(this.w.withStrings([text], (p) => this.x.sk_load_patch(p)));
    if (!res.ok) return res;
    const saved = JSON.stringify(this.savePatch());
    if (this.sink) this.sink.patch(saved);
    this.dirty = false;
    this.emitAll();
    for (const id of this.info.custom) this.emitCustom(id);
    return res;
  }

  // Custom state -----------------------------------------------------------
  custom(id) { return this.w.json(this.w.withStrings([id], (p) => this.x.sk_get_custom(p))); }
  setCustom(id, value) {
    const json = JSON.stringify(value);
    const ok = this.w.withStrings([id, json], (a, b) => this.x.sk_set_custom(a, b));
    if (!ok) return false;
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
