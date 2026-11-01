// Builds the panel of sections from ui/layout.json, or automatically from
// parameter groups when a synth has no layout.

const KIT_PANELS = {
  voices: { title: "Voices", controls: [
    ["voiceMode", "Mode"], ["glide", "Glide"], ["unison", "Unison"], ["unisonDetune", "Detune"],
    ["unisonSpread", "Spread"], ["bendRange", "Bend"]] },
  master: { title: "Output", controls: [["master", "Level"], ["sk.a4", "A4"]] },
};

function envPanel(n, model) {
  const amp = n === 1 && model.info.synth.ampEnv;
  return {
    title: amp ? "Amp envelope" : `Envelope ${n}`,
    env: n,
    controls: ["attack", "decay", "sustain", "release", "velocity"].map((s) => [`env${n}.${s}`, s[0].toUpperCase() + s.slice(1)]),
  };
}

// Small drawing of an ADSR's shape, redrawn as its knobs move.
class EnvPreview {
  constructor(model, n) {
    this.model = model;
    this.ids = ["attack", "decay", "sustain", "release"].map((s) => `env${n}.${s}`);
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
    for (let n = 1; n <= this.model.info.synth.standardEnvelopes; n++) out.push({ kit: "env" + n });
    const lfos = this.model.mod.lfos ? [{ kit: "lfos" }] : [], shapes = [];
    for (let n = 1; n <= this.model.mod.shapes; n++) shapes.push({ kit: "shape" + n });
    // LFOs and shapes together make a long page: give each kind a tab.
    if (lfos.length && shapes.length) {
      out.push({ tabs: [
        { title: this.model.mod.lfos > 1 || this.model.param("sk.lfos") ? "LFOs" : "LFO", sections: lfos },
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
    if (spec.kit === "lfos") return this.lfos(spec, collapsible);
    const el = this.section(spec);
    if (el) this.decorate(el, spec, collapsible);
    return el;
  }

  // Every LFO panel, plus (when the player adds LFOs) an Add LFO button. Its
  // children sit in the surrounding row as if listed one by one.
  lfos(spec, collapsible) {
    if (!this.model.mod.lfos) return this.missing("lfos");
    const wrap = h("div", { class: "lfo-group" });
    for (let n = 1; n <= this.model.mod.lfos; n++) {
      const el = this.section({ kit: "lfo" + n });
      this.decorate(el, { ...spec, kit: "lfo" + n, id: spec.id && `${spec.id}.${n}`, title: undefined }, collapsible);
      wrap.append(el);
    }
    const cap = this.model.param("sk.lfos");
    if (cap) {
      const add = h("button", { type: "button", class: "lfo-add", onclick: () => skAddLfo(this.app) }, h("span", { class: "lfo-add-plus", "aria-hidden": "true", text: "+" }), "Add LFO");
      const show = (v) => {
        add.hidden = Math.round(v) >= cap.max;
        add.lastChild.textContent = Math.round(v) ? "Add LFO" : "Add an LFO";
      };
      this.model.on("sk.lfos", show);
      show(this.model.get("sk.lfos"));
      wrap.append(add);
    }
    return wrap;
  }

  // Info icon and folding for a panel (the kit's own panels included).
  decorate(sec, spec, collapsible) {
    const title = sec.querySelector(":scope > .panel-title");
    if (!title) return;
    if (spec.title && !title.textContent.trim()) title.prepend(spec.title);
    // The title's text; buttons already in it (an LFO's remove) stay put.
    const text = [...title.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
    const extras = [...title.children];
    if (collapsible || typeof spec.collapsed === "boolean") {
      if (!text) this.problems.push("A collapsible panel in layout.json needs a title to click.");
      const body = h("div", { class: "panel-body", id: `sk-panel-${++this.ids}` });
      while (title.nextSibling) body.append(title.nextSibling);
      sec.append(body);
      const btn = h("button", { type: "button", class: "panel-toggle", "aria-controls": body.id }, SK_CHEVRON(), h("span", { text }));
      title.textContent = "";
      title.append(btn, ...extras);
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
    if (spec.info) title.insertBefore(skInfoButton(spec.info, text), extras[0] || null);
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
      s = { ...s, title: spec.title || s.title, wide: spec.wide, controls: s.controls.map(([param, label]) => ({ param, label })) };
    }
    const controls = h("div", { class: "controls" });
    for (const c of s.controls || []) {
      const el = this.control(c);
      if (el) controls.append(el);
    }
    if (!controls.children.length) return null;
    const sec = h("section", { class: "panel" + (s.wide ? " is-wide" : "") },
      h("h2", { class: "panel-title", text: s.title || "" }));
    if (s.env) sec.append(new EnvPreview(this.model, s.env).root);
    sec.append(controls);
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
