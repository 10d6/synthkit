// The rack (API.md §9): the sound's voices stacked top to bottom, each an
// accordion. A voice's compact strip is always there: Show more / Compact
// view, its name (with a pencil to rename it), mute and solo, volume, pan,
// transpose, scale and key, tune, and × to remove it. Show more opens the
// voice's full interface under the strip: the synth's panels (and, in a
// multi, the voice's own preset bar). One voice is open at a time, because the
// panels edit the selected part (model.selectPart): opening a voice selects it.
//
// One voice outside a multi starts open; voices of a multi start closed. Add
// voice (multi synths) turns one voice into a multi, or adds to one; a multi
// gets Layers and splits (multi.js) at the top.

// The strip's settings: the patch's own parameters (API.md §3), so a voice
// keeps them when it's saved, loaded or added from a preset.
const SK_STRIP = { volume: "master", pan: "sk.pan", transpose: "sk.transpose", scale: "sk.scale", key: "sk.scaleKey", tune: "sk.a4" };

// One part's parameters as a model, for the kit's controls (controls.js): a
// voice strip edits its own part whether or not that part is selected. Pan
// reads L/C/R and Tune (A4 in Hz) reads in cents from 440.
function skPartModel(model, part) {
  const cents = (hz) => 1200 * Math.log2(hz / 440);
  const pm = Object.create(model);
  Object.assign(pm, {
    get: (id) => model.getIn(part, id),
    set: (id, v, source) => model.setIn(part, id, v, source),
    norm: (id) => model.toNorm(id, model.getIn(part, id)),
    setNorm: (id, n, source) => model.setIn(part, id, model.fromNorm(id, Math.min(1, Math.max(0, n))), source),
    reset: (id) => model.setIn(part, id, model.param(id).def, "ui"),
    on: (id, fn) => model.onIn(part, id, fn),
    gesture: (id, on) => model.gestureIn(part, id, on),
    format: (id, v) => {
      const p = model.param(id);
      if (v === undefined) v = model.getIn(part, id);
      if (p && p.id === SK_STRIP.tune) { const c = Math.round(cents(v)); return `${c > 0 ? "+" : c < 0 ? "−" : ""}${Math.abs(c)} ct`; }
      if (p && p.id === SK_STRIP.pan) { const n = Math.round(v * 100); return n === 0 ? "C" : `${n < 0 ? "L" : "R"}${Math.abs(n)}`; }
      return model.format(id, v);
    },
    parse: (id, text) => {
      const p = model.param(id);
      const t = String(text).trim().replace("−", "-");
      if (p && p.id === SK_STRIP.tune) { const c = parseFloat(t); return Number.isFinite(c) ? 440 * Math.pow(2, c / 1200) : null; }
      if (p && p.id === SK_STRIP.pan) {
        const u = t.toUpperCase();
        if (u === "C" || u === "0") return 0;
        const n = parseFloat(u.replace(/^[LR]/, ""));
        if (!Number.isFinite(n)) return null;
        return Math.max(-1, Math.min(1, (u.startsWith("L") ? -n : n) / 100));
      }
      return model.parse(id, text);
    },
  });
  return pm;
}

// A knob for the strip: smaller, and Tune's arc starts from 440 Hz.
class StripKnob extends Knob {
  build() {
    super.build();
    if (this.opts.origin !== undefined) this.origin = this.model.toNorm(this.p.index, this.opts.origin);
  }
}

// Fills a <select> with the presets, grouped by category (yours marked);
// option values are indexes into `entries`.
function skFillPresetSelect(select, pr, entries, first) {
  select.textContent = "";
  if (first) select.append(first);
  const groups = new Map();
  const group = (label) => { if (!groups.has(label)) groups.set(label, h("optgroup", { label })); return groups.get(label); };
  entries.forEach((e, i) => {
    const cat = pr.hasCategories() ? pr.catLabel(e.category) : "Presets";
    group(cat + (e.kind === "user" ? " · yours" : "")).append(h("option", { value: String(i), text: e.name }));
  });
  for (const g of groups.values()) select.append(g);
}

class Rack {
  // panels: the synth's panels (Panels.build), shown in the open voice; none
  // for a synth's own page, whose controls follow sk.part instead.
  constructor(app, panels = null) {
    this.app = app;
    this.model = app.model;
    this.panels = panels;
    this.multi = this.model.multi;
    this.rows = [];
    this.openPart = 0;
    this.lastAdded = -1;            // the voice Add voice added last (-1: none since the sound loaded)
    // Voices as they're kept somewhere (a patch's JSON): loaded or saved with
    // the multi, loaded from a preset, or saved as a new voice. Replacing a
    // voice that's one of these loses nothing, so it doesn't ask.
    this.kept = new Set();
    this.layers = this.multi ? new LayersPanel(app) : null;
    this.list = h("div", { class: "rack-voices" });
    this.addVoice = this.multi ? new AddVoice(this) : null;
    this.root = h("div", { class: "rack" }, this.layers && this.layers.root, this.list, this.addVoice && this.addVoice.root);
    this.wasMulti = this.isMulti();
    this.openPart = this.wasMulti ? -1 : 0;
    this.build();

    this.model.onLayout(() => this.layoutChanged());
    // Another part selected (an undo, say): the open voice follows it. Not
    // while adding or removing a voice, which reselect parts along the way.
    this.model.onPart((p) => { if (this.busy) return; if (this.openPart >= 0 && this.openPart !== p) this.setOpen(p); else this.showOpen(); });
    this.model.onName((p) => { if (this.rows[p]) this.rows[p].showName(); });
    app.presets.listeners.add(() => { for (const r of this.rows) r.showName(); });
    skStore.on(`synthkit:${this.model.info.synth.id}:presets`, () => { for (const r of this.rows) r.showName(); });
  }

  get parts() { return this.multi ? this.model.layout().parts.length : 1; }

  // More than one voice, or one that doesn't play every key and velocity:
  // the multi's controls (Layers and splits, mute, solo, remove) show.
  isMulti(l = this.multi ? this.model.layout() : null) {
    if (!l) return false;
    if (l.parts.length > 1) return true;
    const z = l.zones;
    if (z.length !== 1) return true;
    const [kl, kh] = z[0].key || [0, 127], [vl, vh] = z[0].vel || [1, 127];
    return kl !== 0 || kh !== 127 || vl !== 1 || vh !== 127 || typeof z[0].channel === "number" || !!z[0].transpose || !!z[0].gain ||
      !!(z[0].keyFade || z[0].velFade);
  }

  build() {
    for (const r of this.rows) r.destroy();
    this.list.textContent = "";
    this.rows = [];
    const n = this.parts;
    for (let p = 0; p < n; p++) {
      const row = new VoiceRow(this, p);
      this.rows.push(row);
      this.list.append(row.root);
    }
    this.showMulti();
    this.showOpen();
  }

  showMulti() {
    const multi = this.isMulti();
    this.root.classList.toggle("is-multi", multi);
    if (this.layers) this.layers.root.hidden = !multi;
    for (const r of this.rows) r.showMulti(multi);
    if (this.addVoice) this.addVoice.refresh();
  }

  layoutChanged() {
    const multi = this.isMulti();
    if (this.rows.length !== this.parts) {
      // From several voices down to one: it opens, as a single voice does.
      if (this.wasMulti && !multi) this.openPart = 0;
      if (this.openPart >= this.parts) this.openPart = -1;
      this.build();
    } else {
      if (this.wasMulti && !multi && this.parts === 1) this.openPart = 0;
      this.showMulti();
      for (const r of this.rows) r.showFlags();
      this.showOpen();
    }
    this.wasMulti = multi;
  }

  // A whole new sound (the sound bar, an import, the session): the defaults.
  soundLoaded() {
    this.lastAdded = -1;
    this.keepClean();
    if (this.layers) this.layers.sel = -1;   // its default again (layers.defaultZone)
    this.wasMulti = this.isMulti();
    this.openPart = this.wasMulti ? -1 : 0;
    if (this.openPart === 0 && this.model.part !== 0) this.model.selectPart(0);
    this.build();
  }

  // ---- which voices are kept as they are ---------------------------------------------

  sigOf(p, ms = this.model.multiSave()) { const pt = (ms.parts || [])[p]; return pt && pt.patch ? JSON.stringify(pt.patch) : ""; }
  keep(p) { const s = this.sigOf(p); if (s) this.kept.add(s); }
  // Every voice as it is now (the multi, or the one preset, was just saved).
  keepAll() { const ms = this.model.multiSave(); (ms.parts || []).forEach((_, p) => this.kept.add(this.sigOf(p, ms))); }
  // The voices not changed since the sound loaded (a session can bring back
  // one with unsaved changes: that one isn't kept).
  keepClean() {
    if (!this.multi) return;
    const ms = this.model.multiSave();
    (ms.parts || []).forEach((_, p) => { if (!this.model.dirtyParts[p]) this.kept.add(this.sigOf(p, ms)); });
  }
  isKept(p) { return this.kept.has(this.sigOf(p)); }

  // Before voice p is replaced: if it has changes kept nowhere, ask first:
  // Save as new voice, Don't save or Cancel. True to go ahead.
  async confirmReplace(p) {
    if (this.isKept(p) || !skPrefs.get().warnUnsaved) return true;
    const again = h("input", { type: "checkbox", class: "sk-dont-ask" });
    const choice = await skDialog({
      title: "Unsaved voice",
      message: `“${this.model.nameOf(p) || "This voice"}” has changes that aren't saved in this multi or as a preset. Save it as a new voice before replacing it?`,
      body: h("label", { class: "sk-check sk-check-small" }, again, h("span", { text: "Don't ask again" })),
      className: "sk-dialog-unsaved",
      buttons: [
        { label: "Cancel", value: "cancel" },
        { label: "Don't save", value: "discard" },
        { label: "Save as new voice", value: "save", primary: true },
      ],
    });
    if (choice === "cancel") return false;
    if (again.checked) skPrefs.set({ warnUnsaved: false });
    if (choice === "save") return await this.saveCopy(p);
    return true;
  }

  // The picker under a voice's name: voice p plays preset `entry` instead.
  // Its zones, mute and solo stay; everything in the patch (volume, pan,
  // transpose…) is the preset's. One undo step; the open voice stays open.
  async pickVoice(p, entry) {
    const m = this.model, n = this.parts;
    if (!this.multi || p < 0 || p >= n || !entry) return false;
    if (!(await this.confirmReplace(p))) return false;
    const patch = JSON.parse(JSON.stringify(entry.patch || { synth: m.info.synth.id, name: entry.name, params: {} }));
    const pr = this.app.presets;
    const currents = { ...pr.currents, [pr.shownPart]: pr.current };
    const dirty = m.dirtyParts.slice(0, n);
    const was = m.part, edited = m.lastEdited;
    const ms = m.multiSave();
    ms.parts[p] = { ...ms.parts[p], patch };
    this.busy = true;
    const res = m.loadMulti(ms, { label: `replacing voice ${p + 1} with “${entry.name}”` });
    this.busy = false;
    if (!res.ok) { this.app.toast(`Couldn't load "${entry.name}": ${res.error}`, "error"); return false; }
    for (const w of res.warnings || []) this.app.toast(`${entry.name}: ${w}`, "warn");
    dirty[p] = false;
    m.dirtyParts = dirty;
    m.lastEdited = edited === p ? -1 : edited;
    this.keep(p);
    pr.currents = { ...currents, [p]: pr.ref(entry) };
    this.busy = true;
    if (m.part !== was) m.selectPart(was, { quiet: true });
    this.busy = false;
    pr.shownPart = m.part;
    pr.current = pr.currents[m.part] || pr.currentFor(m.savePatch());
    pr.refresh();
    pr.saveSession();
    if (this.app.sound) this.app.sound.refresh();
    return true;
  }

  // Opens voice p (selecting it), or closes them all (-1).
  setOpen(p) {
    if (p >= 0 && this.multi && p !== this.model.part) {
      this.openPart = p;           // first, so onPart doesn't move it
      this.model.selectPart(p);
    }
    this.openPart = p;
    this.showOpen();
  }

  showOpen() {
    this.rows.forEach((r, p) => r.setOpen(p === this.openPart));
    const row = this.rows[this.openPart];
    if (!row) return;
    if (this.panels && this.panels.parentNode !== row.panelSlot) row.panelSlot.append(this.panels);
  }

  // ---- adding and removing voices ----------------------------------------------------------

  // Adds a voice playing `patch` (from preset entry `entry`), layered over the
  // whole keyboard. One undo step; the open voice stays open.
  addPatch(patch, entry) {
    const m = this.model, n = this.parts;
    if (!this.multi || n >= m.maxParts) return false;
    const pr = this.app.presets;
    const currents = { ...pr.currents, [pr.shownPart]: pr.current };
    const dirty = m.dirtyParts.slice(0, n);
    const was = m.part, edited = m.lastEdited;
    const ms = m.multiSave();
    ms.parts.push({ patch });
    ms.zones = [...(ms.zones || []), { part: n, key: [0, 127], vel: [1, 127] }];
    this.busy = true;
    const res = m.loadMulti(ms, { label: `adding “${patch.name || "a voice"}”` });
    this.busy = false;
    if (!res.ok) { this.app.toast(`Couldn't add the voice: ${res.error}`, "error"); return false; }
    for (const w of res.warnings || []) this.app.toast(w, "warn");
    m.dirtyParts = [...dirty, false];
    m.lastEdited = edited;
    this.lastAdded = n;
    this.keep(n);
    if (this.layers) { this.layers.sel = -1; this.layers.renderZones(); }
    pr.currents = { ...currents, [n]: entry ? pr.ref(entry) : pr.currentFor(patch) };
    this.busy = true;
    if (m.part !== was) m.selectPart(was, { quiet: true });
    this.busy = false;
    pr.shownPart = m.part;
    pr.current = pr.currents[m.part] || pr.currentFor(m.savePatch());
    pr.refresh();
    pr.saveSession();
    if (this.app.sound) this.app.sound.refresh();
    this.app.toast(`Added “${patch.name || "voice"}” as voice ${n + 1}`);
    return true;
  }

  // Removes voice i; the ones after it move down a place (in a plugin, host
  // automation stays with the place, not the sound). One undo step.
  removePart(i) {
    const m = this.model, n = this.parts, was = m.part;
    if (i < 0 || i >= n || n <= 1) return;
    const name = m.nameOf(i);
    const ms = m.multiSave();
    ms.parts.splice(i, 1);
    ms.zones = (ms.zones || []).filter((z) => z.part !== i).map((z) => (z.part > i ? { ...z, part: z.part - 1 } : z));
    const pr = this.app.presets;
    const currents = { ...pr.currents, [pr.shownPart]: pr.current };
    const dirty = m.dirtyParts.slice(0, n);
    const edited = m.lastEdited, added = this.lastAdded;
    const shift = (k) => (k === i ? -1 : k > i ? k - 1 : k);
    const open = this.openPart;
    this.openPart = open === i ? -1 : open > i ? open - 1 : open;
    this.busy = true;
    const res = m.loadMulti(ms, { label: `removing “${name || "voice " + (i + 1)}”` });
    this.busy = false;
    if (!res.ok) { this.openPart = open; this.app.toast(`Couldn't remove the voice: ${res.error}`, "error"); return; }
    // Each voice keeps its preset name and "changed" mark.
    dirty.splice(i, 1);
    m.dirtyParts = dirty;
    m.lastEdited = shift(edited);
    this.lastAdded = shift(added);
    if (this.layers) { this.layers.sel = -1; this.layers.renderZones(); }
    const shifted = {};
    for (let p = 0; p < n; p++) if (p !== i && currents[p]) shifted[p > i ? p - 1 : p] = currents[p];
    pr.currents = shifted;
    const keep = this.openPart >= 0 ? this.openPart : was > i ? was - 1 : Math.min(was, n - 2);
    this.busy = true;
    m.selectPart(keep, { quiet: true });
    this.busy = false;
    pr.shownPart = m.part;
    pr.current = shifted[m.part] || pr.currentFor(m.savePatch());
    pr.refresh();
    pr.saveSession();
    this.showOpen();
  }

  setFlag(p, flag) {
    const l = this.model.layout();
    if (!l.parts[p]) return;
    l.parts[p][flag] = !l.parts[p][flag];
    if (!l.parts[p][flag]) delete l.parts[p][flag];
    this.model.setLayout(l);
  }

  // Save as new voice: a copy of voice p's patch, as it is now, becomes one of
  // your presets under a name not taken yet (a taken one gets a number). The
  // voice stays the multi's own: it isn't linked to the copy and keeps its name.
  async saveCopy(p) {
    const m = this.model, pr = this.app.presets;
    const patch = (m.multiSave().parts[p] || {}).patch;
    if (!patch) return;
    const cats = pr.categories().filter((c) => c !== "");
    const cat = h("select", { class: "sk-field", "aria-label": "Category" },
      h("option", { value: "", text: "None" }), ...cats.map((c) => h("option", { value: c, text: c })));
    cat.value = cats.includes(patch.category) ? patch.category : "";
    const name = await this.app.askName({
      title: "Save as new voice",
      label: "Name",
      initial: m.nameOf(p) || "Voice",
      taken: (n) => pr.nameTaken(n),
      extra: h("label", { class: "sk-field-row" }, h("span", { text: "Category" }), cat),
      ok: "Save copy",
    });
    if (name === null) return false;
    const copy = { ...JSON.parse(JSON.stringify(patch)), name };
    if (cat.value) copy.category = cat.value; else delete copy.category;
    if (!pr.storeCopy(copy)) return false;
    this.keep(p);   // its changes are kept now (as the copy)
    if (this.addVoice) this.addVoice.refresh();
    if (this.app.sound) this.app.sound.refresh();
    this.app.toast(`Saved a copy as “${name}” in your presets`);
    return true;
  }

  // A voice renamed from its strip: its patch's name. It's no longer the
  // preset it was loaded from, so the preset bar shows it as unsaved.
  rename(p, name) {
    const m = this.model, pr = this.app.presets;
    m.setNameIn(p, name);
    if (p === pr.shownPart) pr.current = { kind: "session", name };
    else pr.currents = { ...pr.currents, [p]: { kind: "session", name } };
    pr.refresh();
    pr.saveSession();
    if (this.app.sound) this.app.sound.refresh();
  }
}

class VoiceRow {
  constructor(rack, part) {
    this.rack = rack;
    this.app = rack.app;
    this.model = rack.model;
    this.part = part;
    this.unsubs = [];
    this.build();
  }

  destroy() { for (const u of this.unsubs) u(); this.unsubs = []; }

  build() {
    const m = this.model, p = this.part, pm = skPartModel(m, p);
    // Controls for this part only: no MIDI learn or Modulate… menu (those act
    // on the selected part's panels), and no greying out.
    const papp = Object.create(this.app);
    papp.model = pm;
    papp.enable = null;
    papp.paramMenu = () => {};
    this.papp = papp;
    this.pm = pm;
    const id = `sk-voice-${p}`;

    this.toggleText = h("span", { class: "voice-toggle-text" });
    this.toggle = h("button", { type: "button", class: "voice-toggle", "aria-controls": id + "-body", onclick: () => this.rack.setOpen(this.isOpen ? -1 : p) },
      SK_CHEVRON(), this.toggleText);

    // The name, and renaming it in place.
    this.nameEl = h("span", { class: "voice-name" });
    this.nameInput = h("input", { type: "text", class: "voice-name-input", "aria-label": `Name of voice ${p + 1}`, hidden: true });
    this.nameInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") this.finishRename(true);
      if (e.key === "Escape") this.finishRename(false);
    });
    const icon = (d) => { const s = svg("svg", { viewBox: "0 0 16 16", width: 14, height: 14, "aria-hidden": "true" }); s.append(svg("path", { d, fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" })); return s; };
    this.editBtn = h("button", { type: "button", class: "btn btn-quiet btn-icon voice-edit", title: "Rename this voice", "aria-label": `Rename voice ${p + 1}`, onclick: () => this.startRename() },
      icon("M10.5 2.5 13.5 5.5 5.5 13.5 2 14 2.5 10.5Z M9 4 12 7"));
    this.okBtn = h("button", { type: "button", class: "btn btn-quiet btn-icon voice-ok", title: "Keep this name", "aria-label": "Keep this name", hidden: true, onclick: () => this.finishRename(true) }, icon("M3 8.5 6.5 12 13 4.5"));
    this.cancelBtn = h("button", { type: "button", class: "btn btn-quiet btn-icon voice-cancel", title: "Cancel", "aria-label": "Cancel renaming", hidden: true, onclick: () => this.finishRename(false) }, icon("M4 4 12 12 M12 4 4 12"));
    // Keep the input's blur from cancelling before ✓ / ✗ get the click.
    for (const b of [this.okBtn, this.cancelBtn]) b.addEventListener("pointerdown", (e) => e.preventDefault());
    this.nameInput.addEventListener("blur", () => { if (!this.nameInput.hidden) this.finishRename(true); });

    // Another preset for this voice (in a multi): ‹ the list ›.
    this.pickSel = h("select", { class: "voice-pick-select", "aria-label": `Preset for voice ${p + 1}`, title: "Play another preset in this voice",
      onchange: () => this.pick(Number(this.pickSel.value)) });
    const arrow = (text, d, label) => h("button", { type: "button", class: "btn btn-quiet btn-icon voice-pick-step", title: label, "aria-label": `${label} for voice ${p + 1}`, onclick: () => this.step(d) }, text);
    this.pickRow = h("div", { class: "voice-pick" }, arrow("‹", -1, "Previous preset"), this.pickSel, arrow("›", 1, "Next preset"));
    this.pickSel.addEventListener("keydown", (e) => e.stopPropagation());

    this.muteBtn = h("button", { type: "button", class: "voice-flag", title: `Mute voice ${p + 1}`, "aria-label": `Mute voice ${p + 1}`, onclick: () => this.rack.setFlag(p, "mute") }, "M");
    this.soloBtn = h("button", { type: "button", class: "voice-flag", title: `Solo voice ${p + 1}`, "aria-label": `Solo voice ${p + 1}`, onclick: () => this.rack.setFlag(p, "solo") }, "S");

    const knob = (key, label, extra = {}) => {
      const prm = m.param(SK_STRIP[key]);
      if (!prm) return null;
      const k = new StripKnob(papp, prm, { label, size: "small", ...extra });
      this.unsubs.push(k.unsub);
      return k.root;
    };

    // Transpose: a number with arrows.
    const tp = m.param(SK_STRIP.transpose);
    this.transpose = tp ? h("input", { type: "number", class: "voice-num", min: tp.min, max: tp.max, step: 1, "aria-label": `Transpose voice ${p + 1}, semitones`, title: "Transpose, in semitones" }) : null;
    if (this.transpose) {
      this.transpose.addEventListener("keydown", (e) => e.stopPropagation());
      this.transpose.addEventListener("change", () => {
        const v = Math.max(tp.min, Math.min(tp.max, Math.round(Number(this.transpose.value) || 0)));
        pm.set(tp.index, v, "ui");
        this.showTranspose();
      });
      this.unsubs.push(m.onIn(p, tp.index, () => this.showTranspose()));
    }

    // Scale, and its key once there's a scale.
    const sp = m.param(SK_STRIP.scale), kp = m.param(SK_STRIP.key);
    this.scale = sp ? h("select", { class: "voice-sel voice-scale", "aria-label": `Scale of voice ${p + 1}`, title: "Keep the keys in a scale: a key outside it plays the nearest scale note",
      onchange: () => pm.set(sp.index, Number(this.scale.value), "ui") }, ...(sp.choices || []).map((c, i) => h("option", { value: sp.min + i, text: c }))) : null;
    this.key = kp ? h("select", { class: "voice-sel voice-key", "aria-label": `Key of voice ${p + 1}'s scale`, title: "The scale's key",
      onchange: () => pm.set(kp.index, Number(this.key.value), "ui") }, ...(kp.choices || []).map((c, i) => h("option", { value: kp.min + i, text: c.replace("#", "♯").replace(/^([A-G])b$/, "$1♭") }))) : null;
    if (sp) this.unsubs.push(m.onIn(p, sp.index, () => this.showScale()));
    if (kp) this.unsubs.push(m.onIn(p, kp.index, () => this.showScale()));

    // A copy of this voice as one of your presets (multi only: a single voice
    // saves with the sound bar's Save).
    this.saveCopyBtn = h("button", { type: "button", class: "btn btn-quiet voice-save-copy", title: "Save a copy of this voice as a new preset",
      "aria-label": `Save voice ${p + 1} as a new voice preset`, onclick: () => this.rack.saveCopy(p) },
      icon("M3 2.5h8l2.5 2.5v8.5h-10.5Z M5.5 2.5v3.5h5v-3.5 M5.5 13.5v-4h5v4"), h("span", { class: "voice-save-copy-text", text: "Save as new voice" }));
    this.removeBtn = h("button", { type: "button", class: "btn btn-quiet btn-icon voice-remove", title: `Remove voice ${p + 1}`, "aria-label": `Remove voice ${p + 1}`, onclick: () => this.rack.removePart(p) }, icon("M4 4 12 12 M12 4 4 12"));

    const field = (label, ...els) => h("label", { class: "voice-field" }, h("span", { class: "voice-field-label", text: label }), h("span", { class: "voice-field-input" }, ...els));
    this.strip = h("div", { class: "voice-strip" },
      this.toggle,
      h("div", { class: "voice-id" },
        h("div", { class: "voice-id-name" }, this.nameEl, this.nameInput, this.editBtn, this.okBtn, this.cancelBtn),
        this.pickRow),
      h("div", { class: "voice-flags" }, this.muteBtn, this.soloBtn),
      h("div", { class: "voice-ctls" },
        knob("volume", "Volume"),
        knob("pan", "Pan"),
        this.transpose ? field("Transpose", this.transpose) : null,
        this.scale ? field("Scale", this.scale, this.key) : null,
        knob("tune", "Tune", { origin: 440, info: "Fine tuning, in cents (A4 = 440 Hz at 0)." })),
      h("div", { class: "voice-end" }, this.saveCopyBtn, this.removeBtn));

    this.panelSlot = h("div", { class: "voice-panels" });
    this.body = h("div", { class: "voice-body", id: id + "-body" }, this.panelSlot);
    this.root = h("section", { class: "voice", id, style: `--part:${skPartColor(p)}`, "aria-label": `Voice ${p + 1}` }, this.strip, this.body);
    this.isOpen = null;
    this.showName();
    this.showTranspose();
    this.showScale();
    this.showFlags();
    this.setOpen(false);
  }

  showName() {
    const name = this.model.nameOf(this.part) || "Init";
    this.nameEl.textContent = name;
    this.nameEl.title = name;
    if (this.pickRow && !this.pickRow.hidden) this.showPick();
  }

  // The list, showing the preset of the voice's name (else the name alone).
  showPick() {
    const pr = this.app.presets;
    this.entries = pr.entries();
    const name = this.model.nameOf(this.part);
    const at = this.entries.findIndex((e) => e.name === name && e.kind === "user");
    this.at = at >= 0 ? at : this.entries.findIndex((e) => e.name === name);
    skFillPresetSelect(this.pickSel, pr, this.entries, this.at < 0 ? h("option", { value: "-1", text: name || "Voice" }) : null);
    this.pickSel.value = String(this.at);
  }
  async pick(i) {
    const e = this.entries[i];
    if (e) await this.rack.pickVoice(this.part, e);
    if (this.rack.rows[this.part] === this) this.showPick();   // (cancelled: back to what it was)
  }
  step(d) {
    const n = this.entries.length;
    if (!n) return;
    const i = this.at < 0 ? (d > 0 ? 0 : n - 1) : (this.at + d + n) % n;
    this.pick(i);
  }
  showTranspose() {
    if (!this.transpose || document.activeElement === this.transpose) return;
    this.transpose.value = Math.round(this.pm.get(SK_STRIP.transpose));
  }
  showScale() {
    if (!this.scale) return;
    const v = Math.round(this.pm.get(SK_STRIP.scale));
    this.scale.value = String(v);
    if (this.key) {
      this.key.value = String(Math.round(this.pm.get(SK_STRIP.key)));
      this.key.hidden = v === 0;   // Chromatic needs no key
    }
  }
  showFlags() {
    const l = this.model.layout(), pt = (l.parts || [])[this.part] || {};
    for (const [b, on] of [[this.muteBtn, !!pt.mute], [this.soloBtn, !!pt.solo]]) {
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", String(on));
    }
    this.root.classList.toggle("is-muted", !!pt.mute);
  }
  showMulti(multi) {
    this.muteBtn.parentNode.hidden = !multi;
    this.removeBtn.hidden = !multi;
    this.saveCopyBtn.hidden = !multi;
    this.pickRow.hidden = !multi;
    if (multi) this.showPick();
  }

  setOpen(open) {
    if (this.isOpen === open) return;
    this.isOpen = open;
    this.body.hidden = !open;
    this.root.classList.toggle("is-open", open);
    this.toggle.setAttribute("aria-expanded", String(open));
    this.toggleText.textContent = open ? "Compact view" : "Show more";
    this.toggle.title = open ? "Show just this strip" : "Show all of this voice's controls";
  }

  startRename() {
    this.nameInput.value = this.model.nameOf(this.part);
    this.nameEl.hidden = this.editBtn.hidden = true;
    this.nameInput.hidden = this.okBtn.hidden = this.cancelBtn.hidden = false;
    this.nameInput.focus();
    this.nameInput.select();
  }
  finishRename(commit) {
    if (this.nameInput.hidden) return;
    const name = this.nameInput.value.trim();
    this.nameInput.hidden = this.okBtn.hidden = this.cancelBtn.hidden = true;
    this.nameEl.hidden = this.editBtn.hidden = false;
    if (commit && name && name !== this.model.nameOf(this.part)) this.rack.rename(this.part, name);
    this.editBtn.focus();
  }
}

// Add voice: pick a preset and it plays as another voice, layered over the
// keyboard (Layers and splits arranges it from there).
class AddVoice {
  constructor(rack) {
    this.rack = rack;
    this.app = rack.app;
    this.model = rack.model;
    this.select = h("select", { class: "preset-select add-voice-select", "aria-label": "Add a voice: pick a preset", onchange: () => this.pick() });
    this.note = h("span", { class: "add-voice-note" });
    this.root = h("section", { class: "panel is-wide add-voice", "aria-label": "Add voice" },
      h("h2", { class: "panel-title" }, h("span", { text: "Add voice" }),
        skInfoButton("Pick a preset to play it as another voice, layered over the keyboard. With more than one voice, Layers and splits (at the top) decides which keys play which.", "Add voice")),
      h("div", { class: "add-voice-row" }, this.select, this.note));
    this.app.presets.listeners.add(() => this.refresh());
    skStore.on(`synthkit:${this.model.info.synth.id}:presets`, () => this.refresh());
    this.refresh();
  }

  refresh() {
    const pr = this.app.presets;
    const full = this.rack.parts >= this.model.maxParts;
    this.entries = pr.entries();
    skFillPresetSelect(this.select, pr, this.entries, h("option", { value: "", text: full ? "No room for more voices" : "Choose a preset…" }));
    this.select.value = "";
    this.select.disabled = full;
    this.note.textContent = full ? `${this.model.maxParts} voices is the most a sound can have.` : "";
  }

  pick() {
    const e = this.entries[Number(this.select.value)];
    this.select.value = "";
    if (!e) return;
    const patch = JSON.parse(JSON.stringify(e.patch || { synth: this.model.info.synth.id, name: e.name, params: {} }));
    this.rack.addPatch(patch, e);
  }
}
