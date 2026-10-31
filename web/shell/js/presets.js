// Preset bar: factory presets (embedded in the build), your own presets
// (kept in this browser), import/export as files, and the session (the
// current sound is restored when you come back).

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

class PresetBar {
  constructor(app) {
    this.app = app;
    this.model = app.model;
    this.key = (k) => `synthkit:${this.model.info.synth.id}:${k}`;
    this.factory = this.model.info.presets
      .filter((p) => p.patch)
      .map((p) => ({ name: p.patch.name || p.path, patch: p.patch, file: p.path }));
    this.user = skStore.get(this.key("presets"), {});
    skStore.on(this.key("presets"), () => { this.user = skStore.get(this.key("presets"), {}); this.refresh(); });
    this.current = { kind: "factory", name: "Init" };
    this.listeners = new Set();   // a synth's own page following the presets
    this.build();
    this.model.onAny(() => this.changed());
  }

  build() {
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
      btn("‹", "Previous preset", () => this.step(-1), "btn-icon"),
      h("div", { class: "preset-field" }, this.select, this.nameInput, this.dirtyDot),
      btn("›", "Next preset", () => this.step(1), "btn-icon"),
      this.saveBtn, this.moreBtn, this.fileInput);
    this.refresh();
  }

  entries() {
    return [
      ...this.factory.map((p) => ({ kind: "factory", name: p.name, patch: p.patch })),
      ...Object.keys(this.user).sort((a, b) => a.localeCompare(b)).map((n) => ({ kind: "user", name: n, patch: this.user[n] })),
    ];
  }
  value(e) { return e.kind + ":" + e.name; }

  refresh() {
    this.select.textContent = "";
    const groups = { factory: h("optgroup", { label: "Factory" }), user: h("optgroup", { label: "Yours" }) };
    for (const e of this.entries()) groups[e.kind].append(h("option", { value: this.value(e), text: e.name }));
    if (this.current.kind === "session") groups.user.prepend(h("option", { value: "session:", text: this.current.name + " (unsaved)" }));
    for (const g of Object.values(groups)) if (g.children.length) this.select.append(g);
    this.select.value = this.current.kind === "session" ? "session:" : this.value(this.current);
    this.dirtyDot.hidden = !this.model.dirty;
    this.notify();
  }

  notify() {
    const state = { ...this.current, dirty: !!this.model.dirty };
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
    const factory = this.factory.find((p) => p.name === name);
    this.current = ui.current || (factory ? { kind: "factory", name } : { kind: "session", name: name || "Untitled" });
    this.model.dirty = !!ui.dirty;
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
    const init = this.factory.find((p) => /(^|\/)init\.json$/.test(p.file)) || this.factory[0];
    if (init) this.load({ kind: "factory", name: init.name, patch: init.patch });
    return false;
  }

  load(e) {
    const res = this.model.loadPatch(e.patch);
    if (!res.ok) { this.app.toast(`Couldn't load "${e.name}": ${res.error}`, "error"); return false; }
    for (const w of res.warnings || []) this.app.toast(`${e.name}: ${w}`, "warn");
    this.current = { kind: e.kind, name: e.name };
    this.refresh();
    this.saveSession();
    return true;
  }

  pick(v) {
    const e = this.entries().find((x) => this.value(x) === v);
    if (e) this.load(e);
  }
  step(d) {
    const list = this.entries();
    if (!list.length) return;
    let i = list.findIndex((x) => x.kind === this.current.kind && x.name === this.current.name);
    i = i < 0 ? 0 : (i + d + list.length) % list.length;
    this.load(list[i]);
  }

  save() {
    if (this.current.kind === "user") this.store(this.current.name);
    else this.startNaming("save", this.current.kind === "factory" ? this.current.name + " copy" : this.current.name);
  }
  store(name) {
    this.model.setName(name);
    this.user[name] = this.model.savePatch();
    if (!skStore.set(this.key("presets"), this.user)) this.app.toast("This browser isn't letting the page store presets. Use Export to keep a file instead.", "error");
    this.model.dirty = false;
    this.current = { kind: "user", name };
    this.refresh();
    this.saveSession();
    this.app.toast(`Saved "${name}"`);
  }

  startNaming(mode, initial) {
    this.naming = mode;
    this.select.hidden = true;
    this.nameInput.hidden = false;
    this.nameInput.value = initial;
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
    else this.store(name);
  }

  renameTo(name) {
    if (this.current.kind !== "user" || !name) return false;
    const p = this.user[this.current.name];
    delete this.user[this.current.name];
    this.user[name] = { ...p, name };
    this.current = { kind: "user", name };
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
    this.model.dirty = true;
    this.refresh();
    this.app.toast(`Deleted "${name}". The sound stays loaded until you pick another preset.`);
  }

  init() {
    const init = this.factory.find((p) => /(^|\/)init\.json$/.test(p.file));
    this.load(init ? { kind: "factory", name: init.name, patch: init.patch }
                   : { kind: "factory", name: "Init", patch: { synth: this.model.info.synth.id, name: "Init", params: {} } });
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
      null,
      { label: "Export to file", run: () => this.exportFile() },
      { label: "Import from file…", run: () => this.startImport() },
      null,
      { label: "Start from Init", run: () => this.init() },
    ]);
  }
}
