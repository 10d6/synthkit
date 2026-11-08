// Builds the panel of sections from ui/layout.json, or automatically from
// parameter groups when a synth has no layout.

const KIT_PANELS = {
  voices: { title: "Voices", controls: [
    ["voiceMode", "Mode"], ["glide", "Glide"], ["unison", "Unison"], ["unisonDetune", "Detune"],
    ["unisonSpread", "Spread"], ["bendRange", "Bend"]] },
  master: { title: "Output", controls: [["master", "Level"], ["sk.a4", "A4"]] },
  // The arpeggiator (features.arp, API.md §4b).
  arp: { title: "Arp / Sequencer", feature: "arp.on",
    info: "Arp plays the keys you hold one after another, locked to the tempo. Sequencer lets each key play as usual and adds its own copy of the pattern below: notes at intervals from that key. Latch keeps it going after you let go; the next key you press starts afresh.",
    // Each mode shows only its own controls.
    show: {
      "arp.mode": (m) => Math.round(m.get("arp.on")) === 1, "arp.octaves": (m) => Math.round(m.get("arp.on")) === 1, "arp.sync": (m) => Math.round(m.get("arp.on")) === 1,
      "arp.scaleKey": (m) => Math.round(m.get("arp.on")) === 2, "arp.scale": (m) => Math.round(m.get("arp.on")) === 2, "arp.seqSync": (m) => Math.round(m.get("arp.on")) === 2,
      "arp.keyLevel": (m) => Math.round(m.get("arp.on")) === 2, "arp.seqLevel": (m) => Math.round(m.get("arp.on")) === 2,
      "arp.evolve": (m) => Math.round(m.get("arp.on")) === 2 || (Math.round(m.get("arp.on")) === 1 && Math.round(m.get("arp.mode")) === 7),
    },
    controls: [
    ["arp.on", "Type"], ["arp.mode", "Mode"], ["arp.scale", "Scale",
      "Chromatic: the pattern's rows are semitones from each key. A scale: rows are steps along it, so every key's sequence stays in that one key (the key you play itself is never changed)."],
    ["arp.scaleKey", "Key"], ["arp.rate", "Rate"], ["arp.octaves", "Octaves"], ["arp.gate", "Gate",
      "Each note's length, as a share of a step. Over 100% notes overlap (in Mono or Legato voice mode they glide)."],
    ["arp.swing", "Swing", "Delays every other step. At 100% the late steps sit a third of a step behind: a triplet feel."],
    ["arp.latch", "Latch"], ["arp.sync", "Sync", "Grid: steps fall on the song's grid. Key: steps count from the first key of a phrase."],
    ["arp.seqSync", "Sync", "Key: each key's sequence starts from step 1 when you press it. Grid: it joins the pattern where the song's grid is, so every key's sequence lines up."],
    ["arp.velMode", "Velocity"], ["arp.velFixed", "Fixed vel."],
    ["arp.evolve", "Evolve", "Each time the pattern comes round, a note or two changes (a step up or down, a little earlier or later, left out, louder or softer), so it evolves while staying recognisable. Each phrase (each key, in Sequencer) starts from the pattern as drawn."],
    ["arp.keyLevel", "Key level", "The keys you play, while the sequencer is on. The synth's master level applies to both."],
    ["arp.seqLevel", "Seq level", "The notes the sequencer adds."]] },
  arpEnv: { title: "Note envelope", feature: "arp.on", env: ["arp.attack", "arp.decay", "arp.sustain", "arp.release"],
    info: "An envelope for each note the arpeggiator or sequencer plays. Multiply puts it on top of the synth's own envelope; Replace uses it instead of the kit's amp envelope (a synth that shapes its own attack keeps that, so Replace may not line up with every synth). Crossfade has no attack or release shape: each note fades in as the one before fades out, with equal-power curves; the same pitch twice in a row just carries on.",
    show: {
      "arp.attack": (m) => Math.round(m.get("arp.envMode")) === 1 || Math.round(m.get("arp.envMode")) === 2, "arp.decay": (m) => Math.round(m.get("arp.envMode")) === 1 || Math.round(m.get("arp.envMode")) === 2,
      "arp.sustain": (m) => Math.round(m.get("arp.envMode")) === 1 || Math.round(m.get("arp.envMode")) === 2, "arp.release": (m) => Math.round(m.get("arp.envMode")) === 1 || Math.round(m.get("arp.envMode")) === 2,
      "arp.xfade": (m) => Math.round(m.get("arp.envMode")) === 3, envPreview: (m) => Math.round(m.get("arp.envMode")) === 1 || Math.round(m.get("arp.envMode")) === 2,
    },
    controls: [["arp.envMode", "Mode"], ["arp.attack", "Attack"], ["arp.decay", "Decay"], ["arp.sustain", "Sustain"], ["arp.release", "Release"],
      ["arp.xfade", "Crossfade", "How long each fade takes, as a share of a step. At 100% one note dissolves into the next across the whole step."]] },
  arpPhrase: { title: "Phrase envelope", feature: "arp.on", env: ["arp.phraseAttack", "arp.phraseDecay", "arp.phraseSustain", "arp.phraseRelease"],
    info: "The volume of what the arpeggiator or sequencer plays (the keys themselves don't follow it). It starts with a key and releases when you let go; the notes keep playing through the release, so they fade out instead of stopping. In Sequencer, each key has its own.",
    controls: [["arp.phraseAttack", "Attack"], ["arp.phraseDecay", "Decay"], ["arp.phraseSustain", "Sustain"], ["arp.phraseRelease", "Release"]] },
};

function envPanel(n, model) {
  const amp = n === 1 && model.info.synth.ampEnv;
  return {
    title: amp ? "Amp envelope" : `Envelope ${n}`,
    env: ["attack", "decay", "sustain", "release"].map((s) => `env${n}.${s}`),
    controls: ["attack", "decay", "sustain", "release", "velocity"].map((s) => [`env${n}.${s}`, s[0].toUpperCase() + s.slice(1)]),
  };
}

// Small drawing of an ADSR's shape, redrawn as its knobs move.
class EnvPreview {
  constructor(model, ids) {
    this.model = model;
    this.ids = ids;   // attack, decay, sustain, release
    this.path = svg("path", { class: "env-line" });
    this.fill = svg("path", { class: "env-fill" });
    this.root = svg("svg", { class: "env-preview", viewBox: "0 0 200 60", preserveAspectRatio: "none", "aria-hidden": "true" });
    this.root.append(this.fill, this.path);
    for (const id of this.ids) model.on(id, () => this.draw());
    this.draw();
  }
  draw() {
    const [a, d, s, r] = this.ids.map((id) => this.model.get(id));
    // Times on a soft log scale so short and long envelopes both read well.
    const w = (t) => Math.log1p(t * 40);
    const hold = 0.6;
    const total = w(a) + w(d) + hold + w(r);
    const sx = 196 / total, top = 6, bottom = 56, y = (v) => bottom - v * (bottom - top);
    let x = 2;
    const pts = [[x, bottom]];
    x += w(a) * sx; pts.push([x, y(1)]);
    x += w(d) * sx; pts.push([x, y(s)]);
    x += hold * sx; pts.push([x, y(s)]);
    x += w(r) * sx; pts.push([x, bottom]);
    const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
    this.path.setAttribute("d", line);
    this.fill.setAttribute("d", line + " Z");
  }
}

// Opens whatever tab or collapsed panel is hiding an element, so it can be
// shown (e.g. the matrix after Modulate…).
function skReveal(el) {
  const chain = [];
  for (let n = el; n; n = n.parentElement) if (n.skReveal) chain.push(n.skReveal);
  for (const fn of chain.reverse()) fn();
}

const SK_CHEVRON = () => {
  const s = svg("svg", { class: "panel-chevron", viewBox: "0 0 12 12", "aria-hidden": "true" });
  s.append(svg("path", { d: "M3 4.5 6 7.5 9 4.5" }));
  return s;
};

class Panels {
  constructor(app) {
    this.app = app;
    this.model = app.model;
    this.problems = [];
    this.placed = new Set();
    this.ids = 0;
    this.root = h("div", { class: "panels" });
  }

  build(layout) {
    // Info text for parameters wherever they appear (kit panels included).
    const info = layout && layout.paramInfo;
    this.app.paramInfo = info && typeof info === "object" ? info : {};
    for (const id of Object.keys(this.app.paramInfo)) if (!this.model.param(id)) this.problems.push(`layout.json has paramInfo for "${id}", which isn't a parameter.`);
    // Which tabs were showing and which panels were folded, per synth.
    this.storeKey = `synthkit:${this.model.info.synth.id}:ui`;
    this.ui = skStore.get(this.storeKey, {}) || {};
    this.blocks(layout && Array.isArray(layout.sections) ? layout.sections : this.autoSections(), this.root);
    // Anything the layout forgot still gets a place, so no parameter is unreachable.
    const rest = this.model.params.filter((p) => !p.hidden && !p.kit && !this.placed.has(p.id));
    if (rest.length) this.root.append(this.section({ title: "More", controls: rest.map((p) => ({ param: p.id })) }));
    return this.root;
  }

  remember(key, value) {
    this.ui[key] = value;
    skStore.set(this.storeKey, this.ui);
  }

  autoSections() {
    const groups = new Map();
    for (const p of this.model.params) {
      if (p.hidden || p.kit) continue;
      const g = p.group || "Sound";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push({ param: p.id });
    }
    const out = [...groups].map(([title, controls]) => ({ title, controls }));
    out.push({ kit: "voices" });
    if (this.model.param("arp.on")) out.push({ kit: "arp" }, { kit: "arpPattern" }, { kit: "arpEnv" }, { kit: "arpPhrase" });
    for (let n = 1; n <= this.model.info.synth.standardEnvelopes; n++) out.push({ kit: "env" + n });
    const lfos = [], shapes = [];
    for (let n = 1; n <= this.model.mod.lfos; n++) lfos.push({ kit: "lfo" + n });
    for (let n = 1; n <= this.model.mod.shapes; n++) shapes.push({ kit: "shape" + n });
    // LFOs and shapes together make a long page: give each kind a tab.
    if (lfos.length && shapes.length) {
      out.push({ tabs: [
        { title: lfos.length > 1 ? "LFOs" : "LFO", sections: lfos },
        { title: shapes.length > 1 ? "Shapes" : "Shape", sections: shapes }] });
    } else out.push(...lfos, ...shapes);
    if (this.model.mod.slots) out.push({ kit: "modMatrix" });
    out.push({ kit: "master" });
    return out;
  }

  blocks(list, into) {
    for (const spec of list) {
      const el = this.block(spec);
      if (el) into.append(el);
    }
  }

  // One entry of "sections": a panel, a row of tabs, or an accordion.
  block(spec, collapsible = false) {
    if (!spec || typeof spec !== "object") { this.problems.push(`layout.json has a section that isn't an object: ${JSON.stringify(spec)}.`); return null; }
    if ("tabs" in spec) return this.tabs(spec);
    if ("accordion" in spec) return this.accordion(spec);
    const el = this.section(spec);
    if (el) this.decorate(el, el.skKitInfo && !("info" in spec) ? { ...spec, info: el.skKitInfo } : spec, collapsible);
    return el;
  }

  // Info icon and folding for a panel (the kit's own panels included).
  decorate(sec, spec, collapsible) {
    const title = sec.querySelector(":scope > .panel-title");
    if (!title) return;
    if (spec.title && !title.textContent) title.textContent = spec.title;
    const text = title.textContent;
    if (collapsible || typeof spec.collapsed === "boolean") {
      if (!text) this.problems.push("A collapsible panel in layout.json needs a title to click.");
      const body = h("div", { class: "panel-body", id: `sk-panel-${++this.ids}` });
      while (title.nextSibling) body.append(title.nextSibling);
      sec.append(body);
      const btn = h("button", { type: "button", class: "panel-toggle", "aria-controls": body.id }, SK_CHEVRON(), h("span", { text }));
      title.textContent = "";
      title.append(btn);
      sec.classList.add("is-collapsible");
      const key = "open:" + (spec.id || spec.kit || text);
      sec.skOpen = (open, save) => {
        body.hidden = !open;
        sec.classList.toggle("is-collapsed", !open);
        btn.setAttribute("aria-expanded", String(open));
        if (save) this.remember(key, open);
        if (open && save && sec.skSiblings) for (const o of sec.skSiblings) if (o !== sec && !o.querySelector(":scope > .panel-body").hidden) o.skOpen(false, true);
      };
      sec.skReveal = () => { if (body.hidden) sec.skOpen(true, true); };
      btn.addEventListener("click", () => sec.skOpen(body.hidden, true));
      // The whole title row folds it (the button is there for the keyboard).
      title.addEventListener("click", (e) => { if (!e.target.closest(".panel-toggle, .info-btn")) sec.skOpen(body.hidden, true); });
      sec.skOpen(typeof this.ui[key] === "boolean" ? this.ui[key] : spec.collapsed !== true, false);
    }
    if (spec.info) title.append(skInfoButton(spec.info, text));
  }

  // { "accordion": [ sections… ], "single": true }: panels stacked in one
  // column, each folding at its title; "single" keeps one open at a time.
  accordion(spec) {
    if (!Array.isArray(spec.accordion)) { this.problems.push(`"accordion" in layout.json should be a list of sections.`); return null; }
    const wrap = h("div", { class: "accordion" + (spec.wide ? " is-wide" : "") });
    const items = [];
    for (const item of spec.accordion) {
      if (item && ("tabs" in item || "accordion" in item)) { this.problems.push("An accordion in layout.json holds panels, not tabs or other accordions."); continue; }
      const el = this.block(item, true);
      if (el) { wrap.append(el); if (el.skOpen) items.push(el); }
    }
    if (!wrap.children.length) return null;
    if (spec.single) {
      let seen = false;
      for (const el of items) {
        el.skSiblings = items;
        const open = !el.querySelector(":scope > .panel-body").hidden;
        if (open && seen) el.skOpen(false, false);
        seen = seen || open;
      }
    }
    return wrap;
  }

  // { "tabs": [ { "title": "…", "sections": [ … ] }, … ] }: one tab's
  // sections show at a time. Takes a full row.
  tabs(spec) {
    if (!Array.isArray(spec.tabs)) { this.problems.push(`"tabs" in layout.json should be a list of { "title", "sections" }.`); return null; }
    const wrap = h("div", { class: "tabs" });
    const list = h("div", { class: "tab-list", role: "tablist", "aria-label": spec.title || "Sections" });
    const buttons = [], panes = [];
    for (const t of spec.tabs) {
      if (!t || !t.title || !Array.isArray(t.sections)) { this.problems.push(`Each tab in layout.json needs a "title" and a list of "sections" (got ${JSON.stringify(t)}).`); continue; }
      const id = ++this.ids;
      const pane = h("div", { class: "tab-pane panels", role: "tabpanel", id: `sk-tabpane-${id}`, "aria-labelledby": `sk-tab-${id}` });
      this.blocks(t.sections, pane);
      if (!pane.children.length) continue;   // e.g. only panels this synth doesn't enable
      const i = buttons.length;
      const b = h("button", { type: "button", class: "tab", role: "tab", id: `sk-tab-${id}`, "aria-controls": pane.id, text: t.title });
      b.addEventListener("click", () => select(i, true));
      buttons.push(b);
      panes.push(pane);
      pane.skReveal = () => select(i, true);
    }
    if (!panes.length) return null;
    const key = "tab:" + (spec.id || spec.title || spec.tabs.map((t) => t && t.title).join("|"));
    const select = (i, save) => {
      buttons.forEach((b, j) => {
        b.setAttribute("aria-selected", String(j === i));
        b.tabIndex = j === i ? 0 : -1;
        panes[j].hidden = j !== i;
      });
      if (save) this.remember(key, buttons[i].textContent);
    };
    list.addEventListener("keydown", (e) => {
      const at = buttons.indexOf(document.activeElement);
      if (at < 0) return;
      const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: buttons.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      const n = (to + buttons.length) % buttons.length;
      select(n, true);
      buttons[n].focus();
    });
    list.append(...buttons);
    wrap.append(list, ...panes);
    const stored = buttons.findIndex((b) => b.textContent === this.ui[key]);
    select(stored >= 0 ? stored : 0, false);
    return wrap;
  }

  section(spec) {
    let s = spec;
    const lfo = spec.kit && /^lfo(\d+)$/.exec(spec.kit);
    if (lfo) return Number(lfo[1]) <= this.model.mod.lfos ? new LfoPanel(this.app, Number(lfo[1])).root : this.missing(spec.kit);
    const shape = spec.kit && /^shape(\d+)$/.exec(spec.kit);
    if (shape) return Number(shape[1]) <= this.model.mod.shapes ? new ShapePanel(this.app, Number(shape[1]), spec.title).root : this.missing(spec.kit);
    if (spec.kit === "arpPattern") return this.model.param("arp.pattern") ? new ArpPatternPanel(this.app, spec.title).root : this.missing(spec.kit);
    if (spec.kit === "modMatrix") {
      if (!this.model.mod.slots) return this.missing(spec.kit);
      this.app.matrix = new MatrixPanel(this.app);
      return this.app.matrix.root;
    }
    if (spec.kit) {
      const m = /^env(\d+)$/.exec(spec.kit);
      if (m) s = envPanel(Number(m[1]), this.model);
      else if (KIT_PANELS[spec.kit]) s = KIT_PANELS[spec.kit];
      else return this.missing(spec.kit);
      if (s.feature && !this.model.param(s.feature)) return this.missing(spec.kit);
      s = { ...s, title: spec.title || s.title, wide: spec.wide, controls: s.controls.map(([param, label, info]) => (info ? { param, label, info } : { param, label })) };
    }
    const controls = h("div", { class: "controls" });
    for (const c of s.controls || []) {
      const el = this.control(c);
      if (el) controls.append(el);
    }
    if (!controls.children.length) return null;
    const sec = h("section", { class: "panel" + (s.wide ? " is-wide" : "") },
      h("h2", { class: "panel-title", text: s.title || "" }));
    const preview = s.env ? new EnvPreview(this.model, s.env).root : null;
    if (preview) sec.append(preview);
    if (spec.kit && s.info) sec.skKitInfo = s.info;   // a kit panel's own ⓘ text, unless the layout gives one
    sec.append(controls);
    if (s.show) {
      // Controls that only apply in some modes come and go with them.
      const update = () => {
        for (const [id, fn] of Object.entries(s.show)) {
          const el = id === "envPreview" ? preview : controls.querySelector(`[data-param="${id}"]`);
          if (el) el.hidden = !fn(this.model);
        }
      };
      for (const id of ["arp.on", "arp.mode", "arp.envMode"]) if (this.model.param(id)) this.model.on(id, update);
      update();
    }
    return sec;
  }

  missing(kit) {
    this.problems.push(`layout.json asks for the "${kit}" panel, but synth.json doesn't enable that feature.`);
    return null;
  }

  control(c) {
    if (c.type === "xy") {
      const [a, b] = (c.params || []).map((id) => this.model.param(id));
      if (!a || !b) { this.problems.push(`An xy control needs two known params (got ${JSON.stringify(c.params)}).`); return null; }
      this.placed.add(a.id); this.placed.add(b.id);
      return new XYPad(this.app, a, b, c).root;
    }
    if (c.type && this.app.widgets.has(c.type)) return this.app.customWidget(c);
    const p = this.model.param(c.param);
    if (!p) {
      // Kit params only exist for some feature combinations; skip those quietly.
      if (!/^(voiceMode|glide|unison|unisonDetune|unisonSpread)$/.test(c.param)) this.problems.push(`layout.json mentions "${c.param}", which isn't a parameter.`);
      return null;
    }
    this.placed.add(p.id);
    const ctl = makeControl(this.app, p, c);
    if (!ctl) { this.problems.push(`Unknown control type "${c.type}" for ${c.param}.`); return null; }
    this.app.controls.push(ctl);
    return ctl.root;
  }
}
