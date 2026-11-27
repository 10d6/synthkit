// The sound bar (API.md §5b): the top of the page for a synth with a multi.
// It picks a whole sound, either one of the presets (played as one part across
// the keyboard) or a saved multi (listed under "Multis"), and saves what you
// have: one plain part saves as a preset, anything more as a multi. The
// patch of each part is picked in the multi bar (multi.js), which this bar
// opens ("Layers and splits"). Presets themselves stay in the preset bar
// (presets.js), which this bar uses for them.

const SK_MULTIS = "Multis";

class SoundBar {
  constructor(app) {
    this.app = app;
    this.model = app.model;
    this.presets = app.presets;
    this.key = (k) => `synthkit:${this.model.info.synth.id}:${k}`;
    this.factoryMultis = (this.model.info.multis || []).filter((m) => m.multi).map((m) => ({
      kind: "factory", type: "multi", name: m.multi.name || m.path.replace(/^multis\//, "").replace(/\.json$/, ""),
      multi: m.multi, file: m.path, category: SK_MULTIS,
    }));
    this.userMultis = skStore.get(this.key("multis"), {});
    skStore.on(this.key("multis"), () => { this.userMultis = skStore.get(this.key("multis"), {}); this.refresh(); });
    skStore.on(this.key("presets"), () => this.refresh());   // after the preset bar has read them (it subscribed first)
    // The multi showing, when the sound isn't one plain part (then it's the
    // part's preset), and the multi as it was loaded or saved, for "changed".
    this.multiCurrent = { kind: "session", name: "Untitled multi" };
    this.baseline = null;
    this.category = skStore.get(this.key("soundCategory"), null);
    this.listeners = new Set();
    this.build();

    const hist = this.model.history;
    if (hist) {
      const ui = hist.uiState, restore = hist.onRestore;
      hist.uiState = () => ({ ...(ui ? ui() : {}), sound: this.state() });
      hist.onRestore = (s) => { if (restore) restore(s); if (s && s.sound) this.restore(s.sound); this.refresh(); };
      hist.onChange(() => this.changed());
    }
    this.presets.listeners.add(() => this.changed());
    this.model.onLayout(() => this.changed());
    this.model.onPatch(() => this.changed());
    this.model.onAny(() => this.changed());
  }

  // ---- what the sound is -------------------------------------------------------------

  // One part across every key and velocity, not muted or soloed: the same as
  // playing its patch (whose level, pan and scale are its own), so it's a preset.
  plain(l = this.model.layout()) {
    if (l.parts.length !== 1 || l.zones.length !== 1) return false;
    const p = l.parts[0], z = l.zones[0];
    if (p.mute || p.solo) return false;
    const [kl, kh] = z.key || [0, 127], [vl, vh] = z.vel || [1, 127];
    return z.part === 0 && kl === 0 && kh === 127 && vl === 1 && vh === 127 &&
      Object.keys(z).every((k) => k === "part" || k === "key" || k === "vel");
  }
  // The multi without its name, to tell whether it changed.
  sig() { const m = this.model.multiSave(); delete m.name; return JSON.stringify(m); }

  // What the bar shows: {type: "patch"|"multi", kind, name, file?}.
  shown() {
    if (this.plain()) return { type: "patch", ...this.presets.current };
    return { type: "multi", ...this.multiCurrent };
  }
  get dirty() {
    if (this.plain()) return !!this.model.dirtyParts[0];
    return this.multiCurrent.kind === "session" || this.sig() !== this.baseline;
  }

  // For the session, the plugin's state and undo.
  state() { return { current: { ...this.multiCurrent }, baseline: this.baseline }; }
  restore(s) {
    if (!s) return;
    if (s.current) this.multiCurrent = { ...s.current };
    if (s.baseline !== undefined) this.baseline = s.baseline;
    if (this.multiCurrent.kind === "user" && !this.userMultis[this.multiCurrent.name]) this.multiCurrent = { kind: "session", name: this.multiCurrent.name };
  }

  // ---- the list ------------------------------------------------------------------------

  // Presets (in the preset bar's order and categories), then the multis.
  entries() {
    const patches = this.presets.entries().map((e) => ({ ...e, type: "patch" }));
    const user = Object.keys(this.userMultis).sort((a, b) => a.localeCompare(b))
      .map((n) => ({ kind: "user", type: "multi", name: n, multi: this.userMultis[n], category: SK_MULTIS }));
    return [...patches, ...this.factoryMultis, ...user];
  }
  categories() {
    const cats = this.presets.hasCategories() ? this.presets.categories() : [""];
    return [...cats, SK_MULTIS];
  }
  catLabel(c) { return c === SK_MULTIS ? c : this.presets.hasCategories() ? this.presets.catLabel(c) : "Presets"; }
  visible() { const all = this.entries(); return this.category === null ? all : all.filter((e) => e.category === this.category); }
  value(e) {
    if (e.type === "patch") return "p:" + this.presets.value(e);
    return e.kind === "factory" ? "m:factory:" + e.file : "m:" + e.kind + ":" + e.name;
  }
  find(c) {
    if (!c) return null;
    if (c.type === "patch") { const e = this.presets.find(c); return e ? { ...e, type: "patch" } : null; }
    if (c.kind === "user") return this.entries().find((e) => e.type === "multi" && e.kind === "user" && e.name === c.name) || null;
    if (c.kind === "factory") return this.factoryMultis.find((e) => (c.file && e.file === c.file) || e.name === c.name) || null;
    return null;
  }

  // ---- building and showing --------------------------------------------------------------

  build() {
    this.catSelect = h("select", { class: "preset-category", "aria-label": "Category", title: "Category", onchange: () => this.pickCategory(this.catSelect.value) });
    this.select = h("select", { class: "preset-select sound-select", "aria-label": "Sound", onchange: () => this.pick(this.select.value) });
    this.dirtyDot = h("span", { class: "preset-dirty", title: "Changed since loaded", "aria-label": "Changed since loaded", hidden: true });
    this.tag = h("span", { class: "sound-tag", text: "multi", hidden: true });
    this.nameInput = h("input", { class: "preset-name", type: "text", "aria-label": "Name", hidden: true });
    this.nameInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") this.finishNaming(true);
      if (e.key === "Escape") this.finishNaming(false);
    });
    this.nameInput.addEventListener("blur", () => { if (!this.nameInput.hidden) this.finishNaming(true); });
    this.fileInput = h("input", { type: "file", accept: ".json,application/json", hidden: true, onchange: () => this.importFile() });
    const btn = (label, title, fn, cls = "") => h("button", { type: "button", class: "btn " + cls, title, "aria-label": title, onclick: fn }, label);
    this.saveBtn = btn("Save", "Save sound", () => this.save());
    this.moreBtn = btn("More", "More sound actions", (e) => this.moreMenu(e), "btn-quiet");
    // Opens the multi bar under the header; styled as that drawer's tab.
    this.multiBtn = h("button", { type: "button", class: "btn sound-multi", "aria-expanded": "false", "aria-controls": "sk-multi", title: "Edit this sound's parts and zones",
      onclick: () => this.toggleMulti() }, h("span", { text: "Layers and splits" }), h("span", { class: "sound-multi-caret", "aria-hidden": "true", text: "▾" }));
    this.root = h("div", { class: "presets sound" },
      this.catSelect,
      btn("‹", "Previous sound", () => this.step(-1), "btn-icon"),
      h("div", { class: "preset-field" }, this.select, this.nameInput, this.dirtyDot),
      btn("›", "Next sound", () => this.step(1), "btn-icon"),
      this.tag, this.multiBtn, this.saveBtn, this.moreBtn, this.fileInput);
    this.refresh();
  }

  changed() {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.refresh());
  }

  refresh() {
    const used = new Set(this.entries().map((e) => e.category));
    const shown = this.categories().filter((c) => used.has(c));
    if (this.category !== null && !shown.includes(this.category)) this.category = null;
    this.catSelect.textContent = "";
    this.catSelect.append(h("option", { value: "*", text: "All" }));
    for (const c of shown) this.catSelect.append(h("option", { value: "c:" + c, text: this.catLabel(c) }));
    this.catSelect.value = this.category === null ? "*" : "c:" + this.category;

    const cur = this.shown();
    const curEntry = cur.kind === "session" ? null : this.find(cur);
    this.select.textContent = "";
    const groups = new Map();
    const group = (label) => { if (!groups.has(label)) groups.set(label, h("optgroup", { label })); return groups.get(label); };
    const visible = this.visible();
    if (!curEntry) group("Now").append(h("option", { value: "session:", text: cur.name + " (unsaved)" }));
    else if (!visible.some((e) => this.value(e) === this.value(curEntry))) group("Now").append(h("option", { value: this.value(curEntry), text: `${curEntry.name} (${this.catLabel(curEntry.category)})` }));
    for (const e of visible) group(this.catLabel(e.category) + (e.kind === "user" ? " · yours" : "")).append(h("option", { value: this.value(e), text: e.name }));
    for (const g of groups.values()) this.select.append(g);
    this.select.value = curEntry ? this.value(curEntry) : "session:";
    this.dirtyDot.hidden = !this.dirty;
    this.tag.hidden = cur.type !== "multi";

    const open = !!(this.app.multiBar && this.app.multiBar.open);
    this.multiBtn.setAttribute("aria-expanded", String(open));
    this.multiBtn.classList.toggle("is-on", open);
    const state = { ...cur, dirty: this.dirty };
    for (const fn of this.listeners) { try { fn(state); } catch (err) { console.error(err); } }
  }

  toggleMulti() {
    const mb = this.app.multiBar;
    if (!mb) return;
    mb.setOpen(!mb.open);
    this.refresh();
  }

  pickCategory(v) {
    this.category = v === "*" ? null : v.slice(2);
    skStore.set(this.key("soundCategory"), this.category);
    this.refresh();
  }

  // ---- loading -------------------------------------------------------------------------

  pick(v) {
    const e = this.entries().find((x) => this.value(x) === v);
    if (e) this.load(e);
  }
  step(d) {
    const list = this.visible();
    if (!list.length) return;
    const cur = this.find(this.shown());
    let i = cur ? list.findIndex((e) => this.value(e) === this.value(cur)) : -1;
    i = i < 0 ? (d > 0 ? 0 : list.length - 1) : (i + d + list.length) % list.length;
    this.load(list[i]);
  }

  // A preset as a whole sound: one part, every key.
  single(patch) {
    return { format: "sk.multi", version: 1, synth: this.model.info.synth.id, name: patch.name || "", parts: [{ patch }] };
  }

  load(e) {
    const multi = e.type === "multi" ? e.multi : this.single(e.patch);
    const res = this.model.loadMulti(multi);
    if (!res.ok) { this.app.toast(`Couldn't load "${e.name}": ${res.error}`, "error"); return false; }
    for (const w of res.warnings || []) this.app.toast(`${e.name}: ${w}`, "warn");
    this.presets.multiLoaded();
    if (e.type === "patch") {
      this.presets.current = this.presets.ref(e);
      this.presets.currents = {};
      this.multiCurrent = { kind: "session", name: `${e.name} multi` };
    } else {
      this.multiCurrent = e.kind === "factory" ? { kind: "factory", name: e.name, file: e.file } : { kind: e.kind, name: e.name };
    }
    this.baseline = this.sig();
    this.presets.refresh();
    this.refresh();
    this.presets.saveSession();
    if (this.app.applyPatchTempo) this.app.applyPatchTempo();
    return true;
  }

  init() {
    const init = this.presets.initFor(null);
    this.load(init ? { ...init, type: "patch" } : { type: "patch", kind: "factory", name: "Init", patch: { synth: this.model.info.synth.id, name: "Init", params: {} } });
  }

  // ---- saving ----------------------------------------------------------------------------

  save() {
    const cur = this.shown();
    if (cur.kind === "user") return cur.type === "patch" ? this.presets.store(cur.name) : this.storeMulti(cur.name);
    this.startNaming("save", cur.kind === "factory" ? cur.name + " copy" : cur.name);
  }
  storeMulti(name) {
    this.userMultis[name] = this.model.multiSave(name);
    if (!skStore.set(this.key("multis"), this.userMultis)) { this.app.toast("This browser isn't letting the page store multis. Use Export to keep a file instead.", "error"); return; }
    this.multiCurrent = { kind: "user", name };
    this.baseline = this.sig();
    this.refresh();
    this.presets.refresh();
    this.presets.saveSession();
    this.app.toast(`Saved "${name}"`);
  }
  // A name for what's showing: a preset when it's one plain part, else a multi.
  storeAs(name) {
    if (this.plain()) { this.presets.store(name); this.refresh(); }
    else this.storeMulti(name);
  }

  startNaming(mode, initial) {
    this.naming = mode;
    this.select.hidden = true;
    this.nameInput.hidden = false;
    this.nameInput.value = initial;
    this.nameInput.setAttribute("aria-label", this.plain() ? "Preset name" : "Multi name");
    this.nameInput.focus();
    this.nameInput.select();
  }
  finishNaming(commit) {
    const name = this.nameInput.value.trim();
    const mode = this.naming;
    this.naming = null;
    this.nameInput.hidden = true;
    this.select.hidden = false;
    if (!commit || !name) return;
    if (mode === "rename") this.renameTo(name);
    else this.storeAs(name);
  }

  renameTo(name) {
    const cur = this.shown();
    if (cur.kind !== "user") return false;
    if (cur.type === "patch") { const ok = this.presets.renameTo(name); this.refresh(); return ok; }
    const m = this.userMultis[cur.name];
    delete this.userMultis[cur.name];
    this.userMultis[name] = { ...m, name };
    skStore.set(this.key("multis"), this.userMultis);
    this.multiCurrent = { kind: "user", name };
    this.refresh();
    this.presets.saveSession();
    return true;
  }
  remove() {
    const cur = this.shown();
    if (cur.kind !== "user") return;
    if (cur.type === "patch") { this.presets.remove(); this.refresh(); return; }
    delete this.userMultis[cur.name];
    skStore.set(this.key("multis"), this.userMultis);
    this.multiCurrent = { kind: "session", name: cur.name };
    this.refresh();
    this.app.toast(`Deleted "${cur.name}". The sound stays loaded until you pick another.`);
  }

  // ---- files -----------------------------------------------------------------------------

  exportFile() {
    if (this.plain()) return this.presets.exportFile();
    const name = this.shown().name || "multi";
    const json = JSON.stringify(this.model.multiSave(name), null, 2);
    if (skHost) { this.app.audio.send({ t: "export", kind: "multi", name, json }); return; }
    const blob = new Blob([json + "\n"], { type: "application/json" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `${name.replace(/[^\w\- ]+/g, "")}.multi.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  startImport() {
    if (skHost) this.app.audio.send({ t: "import", kind: "sound" });   // the plugin shows a file dialog
    else this.fileInput.click();
  }
  async importFile() {
    const f = this.fileInput.files[0];
    this.fileInput.value = "";
    if (!f) return;
    this.importText(await f.text(), f.name);
  }
  // A preset or a multi file: loaded as the sound and kept as one of yours.
  importText(text, fileName) {
    let j;
    try { j = JSON.parse(text); } catch { this.app.toast(`${fileName} isn't valid JSON.`, "error"); return; }
    const isMulti = j && j.format === "sk.multi";
    const base = String((j && j.name) || fileName.replace(/(\.multi)?\.json$/i, "")).trim() || "Imported";
    const taken = isMulti ? this.userMultis : this.presets.user;
    let name = base;
    for (let k = 2; taken[name]; k++) name = `${base} ${k}`;
    const res = this.model.loadMulti(isMulti ? j : this.single(j));
    if (!res.ok) { this.app.toast(`Couldn't import ${fileName}: ${res.error}`, "error"); return; }
    for (const w of res.warnings || []) this.app.toast(`${fileName}: ${w}`, "warn");
    this.presets.multiLoaded();
    if (isMulti || !this.plain()) this.storeMulti(name);
    else { this.presets.store(name); this.multiCurrent = { kind: "session", name: `${name} multi` }; this.baseline = this.sig(); this.refresh(); }
  }

  moreMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    const cur = this.shown();
    const user = cur.kind === "user";
    const patch = cur.type === "patch";
    this.app.menu(r.left, r.bottom + 4, [
      { label: "Save as new…", run: () => this.startNaming("save", cur.name + (user ? " 2" : "")) },
      { label: "Rename…", run: () => this.startNaming("rename", cur.name), disabled: !user },
      { label: "Delete", run: () => this.remove(), disabled: !user },
      { label: "Category…", run: () => this.presets.categoryMenu(r.left, r.bottom + 4), disabled: !patch },
      null,
      { label: "Export to file", run: () => this.exportFile() },
      { label: "Import from file…", run: () => this.startImport() },
      null,
      { label: "Start from Init", run: () => this.init() },
    ]);
  }
}
