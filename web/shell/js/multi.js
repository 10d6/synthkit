// The multi bar (API.md §5b): a drawer under the sound bar with a strip of
// parts (each one patch of the synth), the selected part's patch, mix and
// scale, and the zone editor. The sound bar (sound.js) opens it and loads and
// saves whole sounds. The rest of the page edits whichever part is selected
// here. Closed, it shows just the part tabs when the sound has more than one.

const SK_PART_HUES = [212, 28, 150, 330, 52, 265, 185, 0];
const skPartColor = (p, a = 1) => `hsl(${SK_PART_HUES[p % SK_PART_HUES.length]} 62% 56% / ${a})`;
const skKeyLabel = (n) => skNoteName(n);
const SK_KEY_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

class MultiBar {
  constructor(app) {
    this.app = app;
    this.model = app.model;
    this.key = (k) => `synthkit:${this.model.info.synth.id}:${k}`;
    this.sel = -1;                                   // the zone selected in the editor
    this.open = !!skStore.get(this.key("multiOpen"), false);
    this.l = this.model.layout();
    this.openListeners = new Set();
    this.build();
    this.model.onLayout((l) => { this.l = l; this.render(); });
    this.model.onPart(() => this.render());
    this.model.onPatch(() => this.renderParts());
    app.presets.listeners.add(() => this.renderParts());
    this.render();
  }

  get parts() { return this.l.parts.length; }

  // ---- building the pieces ---------------------------------------------------------

  build() {
    const m = this.model;
    this.strip = h("div", { class: "parts", role: "tablist", "aria-label": "Parts" });
    this.strip.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      m.selectPart(Math.max(0, Math.min(this.parts - 1, m.part + (e.key === "ArrowRight" ? 1 : -1))));
      const t = this.strip.querySelector('[aria-selected="true"]');
      if (t) t.focus();
    });
    this.addBtn = h("button", { type: "button", class: "btn part-add", title: "Add a part (layered over the keyboard)", onclick: () => this.addPart() }, "+ Part");

    // The selected part's level, balance and scale: its patch's own
    // parameters (master, sk.pan, sk.scale, sk.scaleKey), so they follow the
    // selected part like every other control.
    this.partLabel = h("span", { class: "mix-part" });
    const ctl = (id, label, type) => {
      const p = m.param(id);
      if (!p) return null;
      const c = makeControl(this.app, p, { label, type });
      this.app.controls.push(c);
      return c.root;
    };
    // The selected part's patch: the kit's preset bar (presets.js), here rather
    // than at the top of the page, which picks whole sounds.
    this.patchSlot = h("div", { class: "mix-patch" });
    this.mix = h("div", { class: "multi-mix" },
      this.partLabel, this.patchSlot,
      ctl("master", "Level", "slider"), ctl("sk.pan", "Balance", "slider"),
      ctl("sk.scale", "Scale", "menu"), ctl("sk.scaleKey", "Key", "menu"));

    this.zones = this.buildZones();

    this.head = h("div", { class: "multi-head" }, this.strip, this.addBtn);
    this.root = h("section", { class: "multi", id: "sk-multi", "aria-label": "Layers and splits: parts and zones" }, this.head, this.mix, this.zones);
    this.showOpen();
  }

  // The drawer: open shows everything; closed shows the part tabs only when
  // there's more than one part (so it's clear which one the knobs edit).
  setOpen(open) {
    this.open = !!open;
    skStore.set(this.key("multiOpen"), this.open);
    this.showOpen();
    this.renderParts();   // the tabs' remove buttons come and go with the drawer
    for (const fn of this.openListeners) fn(this.open);
  }
  showOpen() {
    if (!this.root) return;
    this.root.hidden = !this.open && this.parts <= 1;
    this.root.classList.toggle("is-open", this.open);
    this.addBtn.hidden = !this.open;
    this.mix.hidden = this.zones.hidden = !this.open;
    if (this.open && this.app.presets && this.app.presets.root.parentNode !== this.patchSlot) this.patchSlot.append(this.app.presets.root);
  }

  buildZones() {
    this.map = h("div", { class: "zmap", role: "group", "aria-label": "Zones: keys across, velocity up" });
    this.rects = h("div", { class: "zrects" });
    const ticks = h("div", { class: "zticks", "aria-hidden": "true" });
    for (let n = 0; n < 128; n += 12) ticks.append(h("span", { style: `left:${(n / 128) * 100}%`, text: skKeyLabel(n) }));
    this.map.append(ticks, this.rects);
    this.map.addEventListener("pointerdown", (e) => this.mapDown(e));
    this.map.addEventListener("pointermove", (e) => this.mapMove(e));
    this.map.addEventListener("pointerup", (e) => this.mapUp(e));
    this.map.addEventListener("pointercancel", (e) => this.mapUp(e));

    this.list = h("div", { class: "zlist", role: "listbox", "aria-label": "Zones" });
    this.addZoneBtn = h("button", { type: "button", class: "btn", onclick: () => this.addZone() }, "Add zone");
    this.dupBtn = h("button", { type: "button", class: "btn btn-quiet", onclick: () => this.duplicateZone() }, "Duplicate");
    this.delBtn = h("button", { type: "button", class: "btn btn-quiet", onclick: () => this.deleteZone() }, "Delete");
    this.quickBtn = h("button", { type: "button", class: "btn btn-quiet", "aria-haspopup": "menu", onclick: () => this.quickMenu() }, "Set up… ▾");

    // The selected zone's numbers.
    this.f = {};
    const num = (id, label, min, max, get, set, note) => {
      const input = h("input", { type: "number", min, max, step: 1, class: "zf-num", "aria-label": label });
      input.addEventListener("keydown", (e) => e.stopPropagation());
      input.addEventListener("change", () => {
        const v = Math.max(min, Math.min(max, Math.round(Number(input.value) || 0)));
        this.editZone((z) => set(z, v));
      });
      const out = note ? h("span", { class: "zf-note" }) : null;
      this.f[id] = { input, out, get, note };
      return h("label", { class: "zf" }, h("span", { text: label }), input, out);
    };
    const choice = (id, label, options, get, set) => {
      const sel = h("select", { class: "zf-sel", "aria-label": label, onchange: () => this.editZone((z) => set(z, sel.value)) });
      this.f[id] = { select: sel, options, get };
      return h("label", { class: "zf" }, h("span", { text: label }), sel);
    };
    const keyName = (v) => skKeyLabel(v);
    this.form = h("div", { class: "zform" },
      choice("part", "Part", () => Array.from({ length: this.parts }, (_, i) => [String(i), `${i + 1}`]), (z) => String(z.part), (z, v) => { z.part = Number(v); }),
      num("keyLo", "Lowest key", 0, 127, (z) => z.key[0], (z, v) => { z.key[0] = v; if (z.key[1] < v) z.key[1] = v; }, keyName),
      num("keyHi", "Highest key", 0, 127, (z) => z.key[1], (z, v) => { z.key[1] = v; if (z.key[0] > v) z.key[0] = v; }, keyName),
      num("velLo", "Softest", 1, 127, (z) => z.vel[0], (z, v) => { z.vel[0] = v; if (z.vel[1] < v) z.vel[1] = v; }),
      num("velHi", "Hardest", 1, 127, (z) => z.vel[1], (z, v) => { z.vel[1] = v; if (z.vel[0] > v) z.vel[0] = v; }),
      num("kfi", "Key fade in", 0, 127, (z) => (z.keyFade || [0, 0])[0], (z, v) => { z.keyFade = [v, (z.keyFade || [0, 0])[1]]; }),
      num("kfo", "Key fade out", 0, 127, (z) => (z.keyFade || [0, 0])[1], (z, v) => { z.keyFade = [(z.keyFade || [0, 0])[0], v]; }),
      num("vfi", "Velocity fade in", 0, 127, (z) => (z.velFade || [0, 0])[0], (z, v) => { z.velFade = [v, (z.velFade || [0, 0])[1]]; }),
      num("vfo", "Velocity fade out", 0, 127, (z) => (z.velFade || [0, 0])[1], (z, v) => { z.velFade = [(z.velFade || [0, 0])[0], v]; }),
      choice("curve", "Fade curve", () => [["power", "Equal power"], ["linear", "Linear"]], (z) => z.curve === "linear" ? "linear" : "power", (z, v) => { z.curve = v === "linear" ? "linear" : undefined; }),
      choice("channel", "MIDI channel", () => [["any", "Any"], ...Array.from({ length: 16 }, (_, i) => [String(i), `${i + 1}`])], (z) => (typeof z.channel === "number" ? String(z.channel) : "any"), (z, v) => { z.channel = v === "any" ? undefined : Number(v); }),
      num("transpose", "Transpose", -48, 48, (z) => z.transpose || 0, (z, v) => { z.transpose = v || undefined; }),
      num("gain", "Gain (dB)", -60, 12, (z) => z.gain || 0, (z, v) => { z.gain = v || undefined; }));

    return h("div", { class: "zones" },
      h("div", { class: "zones-bar" }, this.addZoneBtn, this.dupBtn, this.delBtn, this.quickBtn,
        h("span", { class: "zones-hint", text: "Drag a zone to move it, its edges to resize. Arrow keys nudge the selected one." })),
      this.map, this.list, this.form);
  }

  // ---- showing the state -------------------------------------------------------------

  render() {
    this.showOpen();
    this.renderParts();
    this.renderMix();
    this.renderZones();
  }

  renderParts() {
    const m = this.model;
    const names = m.partNames();
    this.strip.textContent = "";
    for (let p = 0; p < this.parts; p++) {
      const pt = this.l.parts[p];
      const on = p === m.part;
      const label = (names[p] && names[p].name) || "Init";
      this.strip.append(h("div", { class: "part" + (on ? " is-selected" : "") + (pt.mute ? " is-muted" : ""), style: `--part:${skPartColor(p)}` },
        h("button", { type: "button", class: "part-tab", role: "tab", "aria-selected": String(on), tabindex: on ? 0 : -1, title: `Edit part ${p + 1}: ${label}`, onclick: () => m.selectPart(p) },
          h("span", { class: "part-num", text: p + 1 }), h("span", { class: "part-name", text: label })),
        h("button", { type: "button", class: "part-flag" + (pt.mute ? " is-on" : ""), "aria-pressed": String(!!pt.mute), title: `Mute part ${p + 1}`, "aria-label": `Mute part ${p + 1}`,
          onclick: () => this.edit((l) => { l.parts[p].mute = !l.parts[p].mute; }) }, "M"),
        h("button", { type: "button", class: "part-flag" + (pt.solo ? " is-on" : ""), "aria-pressed": String(!!pt.solo), title: `Solo part ${p + 1}`, "aria-label": `Solo part ${p + 1}`,
          onclick: () => this.edit((l) => { l.parts[p].solo = !l.parts[p].solo; }) }, "S"),
        // Remove, straight from the tab (only in the open drawer, and never the last part).
        this.open && this.parts > 1 ? h("button", { type: "button", class: "part-flag part-remove", title: `Remove part ${p + 1}`, "aria-label": `Remove part ${p + 1}: ${label}`,
          onclick: () => this.removePart(p) }, "×") : null));
    }
    this.addBtn.disabled = this.parts >= m.maxParts;
  }

  renderMix() {
    const p = this.model.part;
    this.mix.style.setProperty("--part", skPartColor(p));
    this.partLabel.textContent = `Part ${p + 1}`;
  }

  renderZones() {
    const zs = this.l.zones;
    if (this.sel >= zs.length) this.sel = zs.length - 1;
    this.rects.textContent = "";
    this.list.textContent = "";
    zs.forEach((z, i) => {
      const [kl, kh] = z.key || [0, 127], [vl, vh] = z.vel || [1, 127];
      const kfi = (z.keyFade || [0, 0])[0], kfo = (z.keyFade || [0, 0])[1], vfi = (z.velFade || [0, 0])[0], vfo = (z.velFade || [0, 0])[1];
      const wk = kh - kl + 1, wv = vh - vl + 1;
      const rect = h("div", { class: "zrect" + (i === this.sel ? " is-selected" : ""), tabindex: 0, role: "option", "aria-selected": String(i === this.sel), "data-zone": i,
        "aria-label": this.zoneText(z, i), style: `--part:${skPartColor(z.part)};left:${(kl / 128) * 100}%;width:${(wk / 128) * 100}%;top:${((127 - vh) / 127) * 100}%;height:${(wv / 127) * 100}%` });
      const fade = (cls, frac) => { if (frac > 0) rect.append(h("i", { class: "zfade " + cls, style: `--f:${Math.min(1, frac) * 100}%` })); };
      fade("zf-l", kfi / wk); fade("zf-r", kfo / wk); fade("zf-b", vfi / wv); fade("zf-t", vfo / wv);
      rect.append(h("span", { class: "zrect-tag", text: z.part + 1 }));
      rect.addEventListener("keydown", (e) => this.zoneKey(e, i));
      rect.addEventListener("focus", () => { if (this.sel !== i) { this.sel = i; this.syncSelection(); } });
      this.rects.append(rect);
      this.list.append(h("button", { type: "button", class: "zchip" + (i === this.sel ? " is-selected" : ""), role: "option", "aria-selected": String(i === this.sel), style: `--part:${skPartColor(z.part)}`,
        onclick: () => { this.sel = i; this.syncSelection(); } }, h("span", { class: "zswatch" }), this.zoneText(z, i)));
    });
    if (!zs.length) this.list.append(h("span", { class: "zempty", text: "No zones: no key plays any part. Add one, or use Set up…" }));
    this.syncForm();
  }

  zoneText(z, i) {
    const [kl, kh] = z.key || [0, 127], [vl, vh] = z.vel || [1, 127];
    const bits = [`Part ${z.part + 1}`, `${skKeyLabel(kl)}–${skKeyLabel(kh)}`];
    if (vl > 1 || vh < 127) bits.push(`vel ${vl}–${vh}`);
    if (typeof z.channel === "number") bits.push(`ch ${z.channel + 1}`);
    if (z.transpose) bits.push(`${z.transpose > 0 ? "+" : ""}${z.transpose} st`);
    return bits.join(" · ");
  }

  // Which zone is selected changed (not the layout).
  syncSelection() {
    this.rects.querySelectorAll(".zrect").forEach((r, i) => { r.classList.toggle("is-selected", i === this.sel); r.setAttribute("aria-selected", String(i === this.sel)); });
    this.list.querySelectorAll(".zchip").forEach((c, i) => { c.classList.toggle("is-selected", i === this.sel); c.setAttribute("aria-selected", String(i === this.sel)); });
    this.syncForm();
  }

  syncForm() {
    const z = this.l.zones[this.sel];
    this.form.hidden = !z;
    this.dupBtn.disabled = this.delBtn.disabled = !z;
    this.addZoneBtn.disabled = this.l.zones.length >= 64;
    if (!z) return;
    for (const f of Object.values(this.f)) {
      if (f.input) {
        if (document.activeElement !== f.input) f.input.value = f.get(z);
        if (f.out) f.out.textContent = f.note(f.get(z));
      } else {
        const want = f.options().map(([v, t]) => v + "\u0000" + t).join("\u0001");
        if (f.built !== want) {
          f.select.textContent = "";
          for (const [v, t] of f.options()) f.select.append(h("option", { value: v, text: t }));
          f.built = want;
        }
        f.select.value = f.get(z);
      }
    }
  }

  // ---- editing the layout --------------------------------------------------------------

  // fn changes a copy of the layout; quiet: don't toast (a slider drag).
  edit(fn, quiet) {
    const l = this.model.layout();
    fn(l);
    const warnings = this.model.setLayout(l);
    if (!quiet) for (const w of warnings) this.app.toast(w, "warn");
  }
  editZone(fn) {
    const i = this.sel;
    this.edit((l) => { if (l.zones[i]) { fn(l.zones[i]); this.cleanZone(l.zones[i]); } });
  }
  cleanZone(z) {
    for (const k of ["keyFade", "velFade"]) if (z[k] && !z[k][0] && !z[k][1]) delete z[k];
    for (const k of ["curve", "channel", "transpose", "gain"]) if (z[k] === undefined) delete z[k];
  }
  newZone(part, extra = {}) { return { part, key: [0, 127], vel: [1, 127], ...extra }; }

  addPart() {
    const m = this.model;
    if (this.parts >= m.maxParts) return;
    const part = this.parts;
    this.edit((l) => { l.parts.push({ level: 0, pan: 0 }); l.zones.push(this.newZone(part)); });
    m.selectPart(part);
  }
  // Removes part i; the ones after it move down a place (in a plugin, host
  // automation stays with the place, not the sound). The part being edited
  // stays selected, or the one taking the removed part's place.
  removePart(i) {
    const m = this.model, n = this.parts, was = m.part;
    if (i < 0 || i >= n) return;
    if (n <= 1) return;
    const ms = m.multiSave();
    ms.parts.splice(i, 1);
    ms.zones = (ms.zones || []).filter((z) => z.part !== i).map((z) => (z.part > i ? { ...z, part: z.part - 1 } : z));
    const pr = this.app.presets;
    const currents = { ...pr.currents, [pr.shownPart]: pr.current };
    const dirty = m.dirtyParts.slice(0, n);
    const res = m.loadMulti(ms);
    if (!res.ok) { this.app.toast(`Couldn't remove the part: ${res.error}`, "error"); return; }
    // Each part keeps its preset name and "changed" mark.
    dirty.splice(i, 1);
    m.dirtyParts = dirty;
    const shifted = {};
    for (let p = 0; p < n; p++) if (p !== i && currents[p]) shifted[p > i ? p - 1 : p] = currents[p];
    pr.currents = shifted;
    m.selectPart(was > i ? was - 1 : Math.min(was, n - 2), { quiet: true });
    pr.shownPart = m.part;
    pr.current = shifted[m.part] || pr.currentFor(m.savePatch());
    pr.refresh();
    pr.saveSession();
  }
  addZone() {
    const part = this.model.part;
    this.edit((l) => { l.zones.push(this.newZone(Math.min(part, l.parts.length - 1))); });
    this.sel = this.l.zones.length - 1;
    this.syncSelection();
  }
  duplicateZone() {
    const z = this.l.zones[this.sel];
    if (!z) return;
    this.edit((l) => { l.zones.push(JSON.parse(JSON.stringify(z))); });
    this.sel = this.l.zones.length - 1;
    this.syncSelection();
  }
  deleteZone() {
    const i = this.sel;
    if (!this.l.zones[i]) return;
    this.edit((l) => { l.zones.splice(i, 1); });
  }

  // Ready-made arrangements, each one step to undo.
  quickMenu() {
    const n = this.parts;
    const r = this.quickBtn.getBoundingClientRect();
    const set = (build, label) => ({ label, run: () => { this.sel = -1; this.edit((l) => { l.zones = build(l); }); } });
    const split = () => {
      // Equal slices of the keyboard, cut at Cs.
      const cuts = Array.from({ length: n + 1 }, (_, i) => (i === 0 ? 0 : i === n ? 128 : Math.round((i * 128) / n / 12) * 12));
      return this.l.parts.map((_, p) => this.newZone(p, { key: [cuts[p], cuts[p + 1] - 1] }));
    };
    const layers = () => this.l.parts.map((_, p) => this.newZone(p));
    const channels = () => this.l.parts.map((_, p) => this.newZone(p, { channel: p }));
    const velocity = () => {
      const w = Math.floor(127 / n), fade = Math.min(12, Math.floor(w / 2));
      return this.l.parts.map((_, p) => this.newZone(p, {
        vel: [Math.max(1, p * w - (p ? fade : 0) + 1), p === n - 1 ? 127 : (p + 1) * w],
        velFade: [p ? fade : 0, p === n - 1 ? 0 : fade],
      }));
    };
    this.app.menu(r.left, r.bottom + 4, [
      set(layers, "Layer: every part on every key"),
      set(split, "Split: a slice of the keyboard each"),
      set(velocity, "Velocity layers: soft to hard, crossfaded"),
      set(channels, "One MIDI channel per part"),
    ]);
  }

  // ---- the map: dragging zones ------------------------------------------------------------

  geometry() {
    const r = this.rects.getBoundingClientRect();
    return { r, kw: r.width / 128, vh: r.height / 127 };
  }
  keyAt(e, g) { return Math.max(0, Math.min(127, Math.floor((e.clientX - g.r.left) / g.kw))); }
  velAt(e, g) { return Math.max(1, Math.min(127, 127 - Math.floor((e.clientY - g.r.top) / g.vh))); }

  // What part of a zone's rectangle the pointer is on.
  hit(e, rectEl) {
    const b = rectEl.getBoundingClientRect(), edge = 7;
    const l = e.clientX - b.left < edge, r = b.right - e.clientX < edge, t = e.clientY - b.top < edge, bt = b.bottom - e.clientY < edge;
    return { l, r, t, b: bt, move: !(l || r || t || bt) };
  }
  cursorFor(hh) {
    if (!hh) return "";
    if ((hh.l || hh.r) && (hh.t || hh.b)) return (hh.l && hh.t) || (hh.r && hh.b) ? "nwse-resize" : "nesw-resize";
    if (hh.l || hh.r) return "ew-resize";
    if (hh.t || hh.b) return "ns-resize";
    return "grab";
  }

  mapDown(e) {
    const el = e.target.closest(".zrect");
    if (!el || e.button !== 0) { if (!el) { this.sel = -1; this.syncSelection(); } return; }
    const i = Number(el.dataset.zone);
    this.sel = i;
    this.syncSelection();
    const g = this.geometry();
    this.drag = { i, hit: this.hit(e, el), k0: this.keyAt(e, g), v0: this.velAt(e, g), z0: JSON.parse(JSON.stringify(this.l.zones[i])) };
    this.map.setPointerCapture(e.pointerId);
    if (this.model.history) this.model.history.begin("zone");
    e.preventDefault();
  }
  mapMove(e) {
    const g = this.geometry();
    if (!this.drag) {
      const el = e.target.closest && e.target.closest(".zrect");
      this.map.style.cursor = el ? this.cursorFor(this.hit(e, el)) : "";
      return;
    }
    const { i, hit, k0, v0, z0 } = this.drag;
    const k = this.keyAt(e, g), v = this.velAt(e, g);
    const z = JSON.parse(JSON.stringify(z0));
    let [kl, kh] = z0.key, [vl, vh] = z0.vel;
    if (hit.move) {
      const dk = Math.max(-kl, Math.min(127 - kh, k - k0)), dv = Math.max(1 - vl, Math.min(127 - vh, v - v0));
      kl += dk; kh += dk; vl += dv; vh += dv;
    } else {
      if (hit.l) kl = Math.min(k, kh);
      if (hit.r) kh = Math.max(k, kl);
      if (hit.t) vh = Math.max(v, vl);
      if (hit.b) vl = Math.min(v, vh);
    }
    z.key = [kl, kh];
    z.vel = [vl, vh];
    if (JSON.stringify(z.key) === JSON.stringify(this.l.zones[i].key) && JSON.stringify(z.vel) === JSON.stringify(this.l.zones[i].vel)) return;
    this.edit((l) => { l.zones[i] = z; }, true);
  }
  mapUp(e) {
    if (!this.drag) return;
    this.drag = null;
    try { this.map.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (this.model.history) this.model.history.end("zone");
  }

  // Arrows nudge: left/right move in keys, up/down in velocity; Shift resizes.
  zoneKey(e, i) {
    const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); this.sel = i; this.deleteZone(); return; }
    if (!dir) return;
    e.preventDefault();
    const step = e.altKey ? 12 : 1;
    this.edit((l) => {
      const z = l.zones[i];
      let [kl, kh] = z.key, [vl, vh] = z.vel;
      const dk = dir[0] * step, dv = dir[1] * step;
      if (e.shiftKey) {
        kh = Math.max(kl, Math.min(127, kh + dk));
        vh = Math.max(vl, Math.min(127, vh + dv));
      } else {
        const sk = Math.max(-kl, Math.min(127 - kh, dk)), sv = Math.max(1 - vl, Math.min(127 - vh, dv));
        kl += sk; kh += sk; vl += sv; vh += sv;
      }
      z.key = [kl, kh];
      z.vel = [vl, vh];
    }, true);
    const el = this.rects.querySelector(`[data-zone="${i}"]`);
    if (el) el.focus();
  }
}
