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

class Panels {
  constructor(app) {
    this.app = app;
    this.model = app.model;
    this.problems = [];
    this.placed = new Set();
    this.root = h("div", { class: "panels" });
  }

  build(layout) {
    const sections = layout && Array.isArray(layout.sections) ? layout.sections : this.autoSections();
    for (const s of sections) {
      const el = this.section(s);
      if (el) this.root.append(el);
    }
    // Anything the layout forgot still gets a place, so no parameter is unreachable.
    const rest = this.model.params.filter((p) => !p.hidden && !p.kit && !this.placed.has(p.id));
    if (rest.length) this.root.append(this.section({ title: "More", controls: rest.map((p) => ({ param: p.id })) }));
    return this.root;
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
    for (let n = 1; n <= this.model.mod.lfos; n++) out.push({ kit: "lfo" + n });
    for (let n = 1; n <= this.model.mod.shapes; n++) out.push({ kit: "shape" + n });
    if (this.model.mod.slots) out.push({ kit: "modMatrix" });
    out.push({ kit: "master" });
    return out;
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
      s = { ...s, title: spec.title || s.title, controls: s.controls.map(([param, label]) => ({ param, label })) };
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
