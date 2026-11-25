// Preset bar: factory presets (embedded in the build), your own presets
// (kept in this browser), import/export as files, and the session (the
// current sound is restored when you come back). Presets can have a category
// (API.md §5): the patch's "category", or the folder a factory preset is in
// under presets/. With any, the bar gets a category picker and ‹ › stays
// inside the category picked.

// Settings that outlive the page: the browser's local storage, or in the
// plugin a file shared by every instance (the plugin passes its contents in
// and is told about each change).
const skStore = {
  subs: new Map(),
  get(key, fallback) {
    if (skHost) { const v = (skHost.store || {})[key]; return v === undefined || v === null ? fallback : JSON.parse(JSON.stringify(v)); }
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    if (skHost) {
      (skHost.store = skHost.store || {})[key] = JSON.parse(JSON.stringify(value));
      window.__JUCE__.backend.emitEvent("sk", { t: "store", key, value });
      return true;
    }
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
  // Another plugin window changed a setting.
  external(key, value) {
    if (skHost) (skHost.store = skHost.store || {})[key] = value;
    for (const fn of this.subs.get(key) || []) fn(value);
  },
  on(key, fn) {
    if (!this.subs.has(key)) this.subs.set(key, new Set());
    this.subs.get(key).add(fn);
  },
};

const catOf = (patch) => (patch && typeof patch.category === "string" ? patch.category : "");

class PresetBar {
  constructor(app) {
    this.app = app;
    this.model = app.model;
    this.key = (k) => `synthkit:${this.model.info.synth.id}:${k}`;
    this.factory = this.model.info.presets
      .filter((p) => p.patch)
      .map((p) => {
        // A preset in presets/<folder>/ is in that category unless it names one;
        // the category goes into the patch so a copy you save keeps it.
        const parts = p.path.replace(/^presets\//, "").split("/");
        const folder = parts.length > 1 ? parts[0] : "";
        const category = typeof p.patch.category === "string" ? p.patch.category : folder;
        const patch = category && p.patch.category !== category ? { ...p.patch, category } : p.patch;
        return { name: p.patch.name || p.path, patch, file: p.path, category };
      });
    this.user = skStore.get(this.key("presets"), {});
    skStore.on(this.key("presets"), () => { this.user = skStore.get(this.key("presets"), {}); this.refresh(); });
    this.current = { kind: "factory", name: "Init" };
    // The category picked (null: all of them; "": presets without one).
    this.category = skStore.get(this.key("category"), null);
    this.listeners = new Set();   // a synth's own page following the presets
    // Undo/redo (history.js) brings back which preset was showing, and
    // whether the sound had changed since.
    const hist = this.model.history;
    if (hist) {
      hist.uiState = () => ({ current: { ...this.current }, dirty: !!this.model.dirty });
      hist.onRestore = (ui) => {
        if (ui && ui.current) {
          const c = ui.current;
          const gone = (c.kind === "user" || c.kind === "factory") && !this.find(c);
          this.current = gone ? { kind: "session", name: c.name } : { ...c };
          this.model.dirty = gone || !!ui.dirty;
        }
        this.refresh();
        this.saveSession();
        if (this.app.applyPatchTempo) this.app.applyPatchTempo();
      };
    }
    this.build();
    this.model.onAny(() => this.changed());
  }

  build() {
    this.catSelect = h("select", { class: "preset-category", "aria-label": "Category", title: "Category", hidden: true, onchange: () => this.pickCategory(this.catSelect.value) });
    this.select = h("select", { class: "preset-select", "aria-label": "Preset", onchange: () => this.pick(this.select.value) });
    this.dirtyDot = h("span", { class: "preset-dirty", title: "Changed since loaded", "aria-label": "Changed since loaded", hidden: true });
    this.nameInput = h("input", { class: "preset-name", type: "text", "aria-label": "Preset name", hidden: true });
    this.nameInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") this.finishNaming(true);
      if (e.key === "Escape") this.finishNaming(false);
    });
    this.nameInput.addEventListener("blur", () => { if (!this.nameInput.hidden) this.finishNaming(true); });
    this.fileInput = h("input", { type: "file", accept: ".json,application/json", hidden: true, onchange: () => this.importFile() });
    const btn = (label, title, fn, cls = "") => h("button", { type: "button", class: "btn " + cls, title, "aria-label": title, onclick: fn }, label);
    this.saveBtn = btn("Save", "Save preset", () => this.save());
    this.moreBtn = btn("More", "More preset actions", (e) => this.moreMenu(e), "btn-quiet");
    this.root = h("div", { class: "presets" },
      this.catSelect,
      btn("‹", "Previous preset", () => this.step(-1), "btn-icon"),
      h("div", { class: "preset-field" }, this.select, this.nameInput, this.dirtyDot),
      btn("›", "Next preset", () => this.step(1), "btn-icon"),
      this.saveBtn, this.moreBtn, this.fileInput);
    this.refresh();
  }

  // Every preset, in the order the bar shows them: by category (synth.json's
  // order, then the rest by name, then those without one), factory presets
  // before yours.
  entries() {
    const factory = this.factory.map((p) => ({ kind: "factory", name: p.name, patch: p.patch, file: p.file, category: p.category }));
    const user = Object.keys(this.user).sort((a, b) => a.localeCompare(b))
      .map((n) => ({ kind: "user", name: n, patch: this.user[n], category: catOf(this.user[n]) }));
    const all = [...factory, ...user];
    if (!this.hasCategories()) return all;
    const order = new Map(this.categories().map((c, i) => [c, i]));
    return all.map((e, i) => ({ e, i })).sort((a, b) => order.get(a.e.category) - order.get(b.e.category) || a.i - b.i).map((x) => x.e);
  }
  // The presets in the category picked.
  visible() {
    const all = this.entries();
    return this.category === null ? all : all.filter((e) => e.category === this.category);
  }
  hasCategories() {
    return (this.model.info.synth.categories || []).length > 0 || this.factory.some((p) => p.category) || Object.values(this.user).some((p) => catOf(p));
  }
  // Category names in display order; "" (no category) last when any preset has none.
  categories() {
    const listed = this.model.info.synth.categories || [];
    const seen = new Set([...this.factory.map((p) => p.category), ...Object.values(this.user).map(catOf)]);
    const extra = [...seen].filter((c) => c && !listed.includes(c)).sort((a, b) => a.localeCompare(b));
    return [...listed, ...extra, ...(seen.has("") ? [""] : [])];
  }
  catLabel(c) { return c === "" ? "Other" : c; }
  value(e) { return e.kind === "factory" && e.file ? "factory:" + e.file : e.kind + ":" + e.name; }
  // The preset an entry or `current` refers to (factory presets by file, as two
  // categories can each have an "Init").
  find(c) {
    if (!c) return null;
    if (c.kind === "user") return this.entries().find((e) => e.kind === "user" && e.name === c.name) || null;
    if (c.kind !== "factory") return null;
    const all = this.entries().filter((e) => e.kind === "factory");
    return (c.file && all.find((e) => e.file === c.file)) ||
           all.find((e) => e.name === c.name && (c.category === undefined || e.category === c.category)) ||
           all.find((e) => e.name === c.name) || null;
  }

  refresh() {
    const cats = this.hasCategories();
    this.catSelect.hidden = !cats;
    if (cats) {
      const used = new Set(this.entries().map((e) => e.category));
      const shown = this.categories().filter((c) => used.has(c));
      if (this.category !== null && !shown.includes(this.category)) this.category = null;
      this.catSelect.textContent = "";
      this.catSelect.append(h("option", { value: "*", text: "All" }));
      for (const c of shown) this.catSelect.append(h("option", { value: "c:" + c, text: this.catLabel(c) }));
      this.catSelect.value = this.category === null ? "*" : "c:" + this.category;
    } else {
      this.category = null;
    }

    this.select.textContent = "";
    const groups = new Map();
    const group = (label) => { if (!groups.has(label)) groups.set(label, h("optgroup", { label })); return groups.get(label); };
    const byCategory = cats && this.category === null;
    // The sound showing, when it's not one of the presets listed: first, so the
    // picker can always show it.
    const cur = this.current.kind === "session" ? null : this.find(this.current);
    const visible = this.visible();
    if (this.current.kind === "session") group("Now").append(h("option", { value: "session:", text: this.current.name + " (unsaved)" }));
    else if (cur && !visible.some((e) => this.value(e) === this.value(cur))) group("Now").append(h("option", { value: this.value(cur), text: `${cur.name} (${this.catLabel(cur.category)})` }));
    for (const e of visible) {
      const label = byCategory ? this.catLabel(e.category) + (e.kind === "user" ? " · yours" : "") : e.kind === "user" ? "Yours" : "Factory";
      group(label).append(h("option", { value: this.value(e), text: e.name }));
    }
    for (const g of groups.values()) this.select.append(g);
    this.select.value = this.current.kind === "session" ? "session:" : cur ? this.value(cur) : "";
    this.dirtyDot.hidden = !this.model.dirty;
    this.notify();
  }

  pickCategory(v) {
    this.category = v === "*" ? null : v.slice(2);
    skStore.set(this.key("category"), this.category);
    this.refresh();
  }

  // The patch the current preset was loaded from (or last saved as), or null
  // when the sound isn't one of the presets.
  baseline() {
    const e = this.current.kind === "session" ? null : this.find(this.current);
    return e ? e.patch : null;
  }

  notify() {
    const state = { ...this.current, category: this.model.patchCategory, dirty: !!this.model.dirty };
    for (const fn of this.listeners) { try { fn(state); } catch (err) { console.error(err); } }
  }

  changed() {
    const was = this.dirtyDot.hidden;
    this.dirtyDot.hidden = !this.model.dirty;
    if (was !== this.dirtyDot.hidden) this.notify();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveSession(), 400);
  }

  saveSession() {
    // In the plugin the DAW project keeps the sound; the plugin just notes
    // which preset is showing.
    if (skHost) { this.app.audio.send({ t: "meta", ui: { current: this.current, dirty: this.model.dirty } }); return; }
    skStore.set(this.key("session"), { patch: this.model.savePatch(), current: this.current, dirty: this.model.dirty });
  }

  // The plugin's sound (on opening the window, or when the DAW loads a project).
  applyHostState(patch, ui) {
    const res = this.model.loadPatch(patch, { fromHost: true });
    if (!res.ok) { this.app.toast(`Couldn't show the plugin's sound: ${res.error}`, "error"); return false; }
    ui = ui || {};
    const name = patch && patch.name;
    const factory = this.find({ kind: "factory", name, category: catOf(patch) });
    this.current = ui.current || (factory ? this.ref(factory) : { kind: "session", name: name || "Untitled" });
    this.model.dirty = !!ui.dirty;
    // A different sound from the DAW (a project opened): earlier steps don't apply.
    if (this.model.history) this.model.history.clear();
    this.refresh();
    return true;
  }

  restoreSession() {
    if (skHost) return this.applyHostState(skHost.state.patch, skHost.state.ui);
    const s = skStore.get(this.key("session"), null);
    if (s && s.patch && this.model.loadPatch(s.patch).ok) {
      this.current = s.current || { kind: "session", name: s.patch.name || "Untitled" };
      this.model.dirty = !!s.dirty;
      this.refresh();
      return true;
    }
    // First visit: start from Init if the synth has one.
    const init = this.initFor(null) || this.entries().find((e) => e.kind === "factory");
    if (init) this.load(init);
    return false;
  }

  // What `current` keeps of an entry.
  ref(e) { return e.kind === "factory" && e.file ? { kind: e.kind, name: e.name, file: e.file } : { kind: e.kind, name: e.name }; }

  load(e) {
    const res = this.model.loadPatch(e.patch);
    if (!res.ok) { this.app.toast(`Couldn't load "${e.name}": ${res.error}`, "error"); return false; }
    for (const w of res.warnings || []) this.app.toast(`${e.name}: ${w}`, "warn");
    this.current = this.ref(e);
    this.refresh();
    this.saveSession();
    return true;
  }

  pick(v) {
    const e = this.entries().find((x) => this.value(x) === v);
    if (e) this.load(e);
  }
  // The next or previous preset in the category picked.
  step(d) {
    const list = this.visible();
    if (!list.length) return;
    const cur = this.current.kind === "session" ? null : this.find(this.current);
    let i = cur ? list.findIndex((e) => this.value(e) === this.value(cur)) : -1;
    i = i < 0 ? (d > 0 ? 0 : list.length - 1) : (i + d + list.length) % list.length;
    this.load(list[i]);
  }

  save() {
    if (this.current.kind === "user") this.store(this.current.name);
    else this.startNaming("save", this.current.kind === "factory" ? this.current.name + " copy" : this.current.name);
  }
  store(name) {
    this.model.setName(name);
    // A new sound saved while a category is picked goes into it.
    if (this.category && !this.model.patchCategory) this.model.setCategory(this.category);
    this.user[name] = this.model.savePatch();
    if (!skStore.set(this.key("presets"), this.user)) this.app.toast("This browser isn't letting the page store presets. Use Export to keep a file instead.", "error");
    this.model.dirty = false;
    this.current = { kind: "user", name };
    if (this.model.history) this.model.history.saved(this.current);
    this.refresh();
    this.saveSession();
    this.app.toast(`Saved "${name}"`);
  }

  startNaming(mode, initial) {
    this.naming = mode;
    this.select.hidden = true;
    this.nameInput.hidden = false;
    this.nameInput.value = initial;
    this.nameInput.placeholder = mode === "category" ? "New category" : "";
    this.nameInput.setAttribute("aria-label", mode === "category" ? "Category name" : "Preset name");
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
    else if (mode === "category") this.setCategory(name);
    else this.store(name);
  }

  renameTo(name) {
    if (this.current.kind !== "user" || !name) return false;
    const p = this.user[this.current.name];
    const old = this.current;
    delete this.user[this.current.name];
    this.user[name] = { ...p, name };
    this.current = { kind: "user", name };
    if (this.model.history) this.model.history.renamed(old, this.current);
    skStore.set(this.key("presets"), this.user);
    this.model.setName(name);
    this.refresh();
    this.saveSession();
    return true;
  }

  remove() {
    if (this.current.kind !== "user") return;
    const name = this.current.name;
    delete this.user[name];
    skStore.set(this.key("presets"), this.user);
    this.current = { kind: "session", name };
    if (this.model.history) this.model.history.renamed({ kind: "user", name }, this.current);
    this.model.dirty = true;
    this.refresh();
    this.app.toast(`Deleted "${name}". The sound stays loaded until you pick another preset.`);
  }

  // The Init to start from: the category's own (presets/<category>/init.json,
  // or a factory preset named "Init" in it), else presets/init.json, else any.
  initFor(category) {
    const factory = this.entries().filter((e) => e.kind === "factory");
    const isInit = (e) => /(^|\/)init\.json$/.test(e.file);
    if (category) {
      const own = factory.find((e) => e.category === category && isInit(e)) || factory.find((e) => e.category === category && e.name === "Init");
      if (own) return own;
    }
    return factory.find((e) => e.file === "presets/init.json") || factory.find(isInit) || null;
  }
  init() {
    const init = this.initFor(this.category);
    this.load(init || { kind: "factory", name: "Init", patch: { synth: this.model.info.synth.id, name: "Init", params: {} } });
  }

  // Puts the sound showing into a category ("" for none). One of your presets
  // is moved straight away; any other sound keeps it when you save it.
  setCategory(category) {
    category = String(category || "").trim();
    this.model.setCategory(category);
    if (this.current.kind === "user" && this.user[this.current.name]) {
      this.user[this.current.name] = { ...this.user[this.current.name], category };
      if (!category) delete this.user[this.current.name].category;
      skStore.set(this.key("presets"), this.user);
    } else {
      this.model.dirty = true;
    }
    if (this.category !== null && this.category !== category) { this.category = category; skStore.set(this.key("category"), category); }
    this.refresh();
    this.saveSession();
    return true;
  }
  categoryMenu(x, y) {
    const now = this.model.patchCategory;
    const cats = this.categories().filter((c) => c);
    this.app.menu(x, y, [
      ...cats.map((c) => ({ label: (c === now ? "✓ " : "") + c, run: () => this.setCategory(c) })),
      ...(cats.length ? [null] : []),
      { label: "New category…", run: () => this.startNaming("category", "") },
      { label: (now ? "" : "✓ ") + "No category", run: () => this.setCategory(""), disabled: !now },
    ]);
  }

  exportFile() {
    const patch = this.model.savePatch();
    if (skHost) { this.app.audio.send({ t: "export", name: patch.name || "patch", json: JSON.stringify(patch, null, 2) }); return; }
    const blob = new Blob([JSON.stringify(patch, null, 2) + "\n"], { type: "application/json" });
    const a = h("a", { href: URL.createObjectURL(blob), download: (patch.name || "patch").replace(/[^\w\- ]+/g, "") + ".json" });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async importFile() {
    const f = this.fileInput.files[0];
    this.fileInput.value = "";
    if (!f) return;
    this.importText(await f.text(), f.name);
  }
  startImport() {
    if (skHost) this.app.audio.send({ t: "import" });   // the plugin shows a file dialog
    else this.fileInput.click();
  }
  importText(text, fileName) {
    const res = this.model.loadPatch(text);
    if (!res.ok) { this.app.toast(`Couldn't import ${fileName}: ${res.error}`, "error"); return; }
    for (const w of res.warnings || []) this.app.toast(`${fileName}: ${w}`, "warn");
    let name = this.model.patchName || fileName.replace(/\.json$/i, "");
    for (let k = 2; this.user[name]; k++) name = `${this.model.patchName} ${k}`;
    this.store(name);
  }

  moreMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    const user = this.current.kind === "user";
    this.app.menu(r.left, r.bottom + 4, [
      { label: "Save as new…", run: () => this.startNaming("save", this.current.name + (user ? " 2" : "")) },
      { label: "Rename…", run: () => this.startNaming("rename", this.current.name), disabled: !user },
      { label: "Delete", run: () => this.remove(), disabled: !user },
      { label: "Category…", run: () => this.categoryMenu(r.left, r.bottom + 4) },
      null,
      { label: "Export to file", run: () => this.exportFile() },
      { label: "Import from file…", run: () => this.startImport() },
      null,
      { label: "Start from Init", run: () => this.init() },
    ]);
  }
}
