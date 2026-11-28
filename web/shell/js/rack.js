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
    this.wasMulti = this.isMulti();
    this.openPart = this.wasMulti ? -1 : 0;
    if (this.openPart === 0 && this.model.part !== 0) this.model.selectPart(0);
    this.build();
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
    // The voice's preset bar (a multi's voice; one voice uses the sound bar).
    const pr = this.app.presets;
    if (this.multi && this.isMulti()) { if (pr.root.parentNode !== row.presetSlot) row.presetSlot.append(pr.root); }
    else if (this.multi && pr.root.parentNode === row.presetSlot) pr.root.remove();
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
    const was = m.part;
    const ms = m.multiSave();
    ms.parts.push({ patch });
    ms.zones = [...(ms.zones || []), { part: n, key: [0, 127], vel: [1, 127] }];
    this.busy = true;
    const res = m.loadMulti(ms, { label: `adding “${patch.name || "a voice"}”` });
    this.busy = false;
    if (!res.ok) { this.app.toast(`Couldn't add the voice: ${res.error}`, "error"); return false; }
    for (const w of res.warnings || []) this.app.toast(w, "warn");
    m.dirtyParts = [...dirty, false];
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
    const open = this.openPart;
    this.openPart = open === i ? -1 : open > i ? open - 1 : open;
    this.busy = true;
    const res = m.loadMulti(ms, { label: `removing “${name || "voice " + (i + 1)}”` });
    this.busy = false;
    if (!res.ok) { this.openPart = open; this.app.toast(`Couldn't remove the voice: ${res.error}`, "error"); return; }
    // Each voice keeps its preset name and "changed" mark.
    dirty.splice(i, 1);
    m.dirtyParts = dirty;
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

    this.removeBtn = h("button", { type: "button", class: "btn btn-quiet btn-icon voice-remove", title: `Remove voice ${p + 1}`, "aria-label": `Remove voice ${p + 1}`, onclick: () => this.rack.removePart(p) }, icon("M4 4 12 12 M12 4 4 12"));

    const field = (label, ...els) => h("label", { class: "voice-field" }, h("span", { class: "voice-field-label", text: label }), h("span", { class: "voice-field-input" }, ...els));
    this.strip = h("div", { class: "voice-strip" },
      this.toggle,
      h("div", { class: "voice-id" }, this.nameEl, this.nameInput, this.editBtn, this.okBtn, this.cancelBtn),
      h("div", { class: "voice-flags" }, this.muteBtn, this.soloBtn),
      h("div", { class: "voice-ctls" },
        knob("volume", "Volume"),
        knob("pan", "Pan"),
        this.transpose ? field("Transpose", this.transpose) : null,
        this.scale ? field("Scale", this.scale, this.key) : null,
        knob("tune", "Tune", { origin: 440, info: "Fine tuning, in cents (A4 = 440 Hz at 0)." })),
      this.removeBtn);

    this.presetSlot = h("div", { class: "voice-preset" });
    this.panelSlot = h("div", { class: "voice-panels" });
    this.body = h("div", { class: "voice-body", id: id + "-body" }, this.presetSlot, this.panelSlot);
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
    this.select.textContent = "";
    this.select.append(h("option", { value: "", text: full ? "No room for more voices" : "Choose a preset…" }));
    const groups = new Map();
    const group = (label) => { if (!groups.has(label)) groups.set(label, h("optgroup", { label })); return groups.get(label); };
    this.entries = pr.entries();
    this.entries.forEach((e, i) => {
      const cat = pr.hasCategories() ? pr.catLabel(e.category) : "Presets";
      group(cat + (e.kind === "user" ? " · yours" : "")).append(h("option", { value: String(i), text: e.name }));
    });
    for (const g of groups.values()) this.select.append(g);
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
