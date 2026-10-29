// Controls bound to parameters. Every control: drag (Shift = fine), wheel,
// arrow keys, double-click to reset, click the value to type one, right-click
// for MIDI learn.

function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "text") e.textContent = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}

function svg(tag, attrs = {}) {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

const KNOB_START = -135, KNOB_END = 135;

function arcPath(cx, cy, r, a0, a1) {
  const rad = (a) => ((a - 90) * Math.PI) / 180;
  const x0 = cx + r * Math.cos(rad(a0)), y0 = cy + r * Math.sin(rad(a0));
  const x1 = cx + r * Math.cos(rad(a1)), y1 = cy + r * Math.sin(rad(a1));
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const sweep = a1 > a0 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

// Vertical/horizontal drag on an element, in normalised units.
function attachDrag(target, ctl, axis = "y") {
  let start = null;
  target.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    target.setPointerCapture(e.pointerId);
    start = { x: e.clientX, y: e.clientY, n: ctl.norm(), moved: false };
    ctl.root.classList.add("is-active");
    ctl.focus();
  });
  target.addEventListener("pointermove", (e) => {
    if (!start) return;
    const range = e.shiftKey ? 1200 : axis === "x" ? Math.max(120, target.clientWidth) : 180;
    const d = axis === "x" ? e.clientX - start.x : start.y - e.clientY;
    if (Math.abs(d) > 2) start.moved = true;
    ctl.setNorm(start.n + d / range);
  });
  const end = () => { start = null; ctl.root.classList.remove("is-active"); };
  target.addEventListener("pointerup", end);
  target.addEventListener("pointercancel", end);
  target.addEventListener("dblclick", () => ctl.reset());
  target.addEventListener("wheel", (e) => {
    e.preventDefault();
    const step = e.shiftKey ? 0.002 : 0.01;
    ctl.setNorm(ctl.norm() + (e.deltaY < 0 ? step : -step) * (ctl.stepScale || 1));
  }, { passive: false });
}

class Control {
  constructor(app, param, opts = {}) {
    this.app = app;
    this.model = app.model;
    this.p = param;
    this.opts = opts;
    this.label = opts.label || param.name;
    this.discrete = param.type !== "float";
    this.steps = this.discrete ? Math.round((param.max - param.min) / (param.step || 1)) : 0;
    this.stepScale = this.discrete ? Math.max(1, 100 / Math.max(1, this.steps)) : 1;
    this.root = h("div", { class: "ctl ctl-" + this.kind() + (opts.size ? " is-" + opts.size : ""), "data-param": param.id });
    this.build();
    this.unsub = this.model.on(param.index, (v) => this.update(v));
    this.root.addEventListener("contextmenu", (e) => { e.preventDefault(); app.paramMenu(this, e.clientX, e.clientY); });
    this.update(this.model.get(param.index));
  }
  kind() { return "base"; }
  norm() { return this.model.norm(this.p.index); }
  setNorm(n) {
    if (this.discrete && this.steps > 0) n = Math.round(Math.min(1, Math.max(0, n)) * this.steps) / this.steps;
    this.model.setNorm(this.p.index, n, "ui");
  }
  set(v) { this.model.set(this.p.index, v, "ui"); }
  reset() { this.model.reset(this.p.index); }
  focus() { const f = this.root.querySelector("[tabindex]"); if (f) f.focus({ preventScroll: true }); }
  text(v) { return this.model.format(this.p.index, v); }

  keyHandler(e) {
    const big = e.shiftKey ? 0.001 : 0.01;
    const step = this.discrete ? 1 / Math.max(1, this.steps) : big;
    let n = null;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") n = this.norm() + step;
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") n = this.norm() - step;
    else if (e.key === "PageUp") n = this.norm() + 0.1;
    else if (e.key === "PageDown") n = this.norm() - 0.1;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = 1;
    else if (e.key === "Delete" || e.key === "Backspace") { this.reset(); e.preventDefault(); return; }
    if (n !== null) { e.preventDefault(); e.stopPropagation(); this.setNorm(n); }
  }

  // The value readout doubles as a text field.
  valueField() {
    const v = h("button", { class: "ctl-value", type: "button", title: "Type a value" });
    v.addEventListener("click", () => this.editValue(v));
    return v;
  }
  editValue(btn) {
    const input = h("input", { class: "ctl-edit", type: "text", value: this.text(), "aria-label": this.label });
    btn.replaceWith(input);
    input.select();
    let finished = false;
    const done = (commit) => {
      if (finished) return;
      finished = true;
      if (commit) {
        const v = this.model.parse(this.p.index, input.value.trim());
        if (v !== null) this.set(v);
      }
      input.replaceWith(btn);
      this.update(this.model.get(this.p.index));
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") done(true);
      if (e.key === "Escape") done(false);
    });
    input.addEventListener("blur", () => done(true));
  }
  aria(el, v) {
    el.setAttribute("aria-valuetext", this.text(v));
    el.setAttribute("aria-valuenow", Math.round(this.model.toNorm(this.p.index, v) * 100));
  }
  learned(cc) { this.root.classList.toggle("has-cc", cc !== null && cc !== undefined); this.root.title = cc != null ? `${this.label}: MIDI CC ${cc}` : ""; }
}

class Knob extends Control {
  kind() { return "knob"; }
  build() {
    const p = this.p;
    this.origin = p.min < 0 && p.max > 0 ? this.model.toNorm(p.index, 0) : 0;
    const s = svg("svg", { viewBox: "0 0 100 100", class: "knob-svg", "aria-hidden": "true" });
    s.append(svg("path", { class: "knob-track", d: arcPath(50, 50, 42, KNOB_START, KNOB_END) }));
    this.arc = svg("path", { class: "knob-arc" });
    s.append(this.arc);
    s.append(svg("circle", { class: "knob-cap", cx: 50, cy: 50, r: 31 }));
    this.pointer = svg("line", { class: "knob-pointer", x1: 50, y1: 50, x2: 50, y2: 23 });
    s.append(this.pointer);
    this.dial = h("div", { class: "knob-dial", role: "slider", tabindex: 0, "aria-label": this.label, "aria-valuemin": 0, "aria-valuemax": 100 }, s);
    this.dial.addEventListener("keydown", (e) => this.keyHandler(e));
    attachDrag(this.dial, this);
    this.value = this.valueField();
    this.root.append(this.dial, h("div", { class: "ctl-label", text: this.label }), this.value);
  }
  update(v) {
    const n = this.model.toNorm(this.p.index, v);
    const a = KNOB_START + (KNOB_END - KNOB_START) * n;
    const a0 = KNOB_START + (KNOB_END - KNOB_START) * this.origin;
    this.arc.setAttribute("d", Math.abs(a - a0) < 0.5 ? "" : arcPath(50, 50, 42, Math.min(a0, a), Math.max(a0, a)));
    this.pointer.setAttribute("transform", `rotate(${a.toFixed(1)} 50 50)`);
    this.value.textContent = this.text(v);
    this.aria(this.dial, v);
  }
}

class Slider extends Control {
  kind() { return "slider"; }
  build() {
    this.fill = h("div", { class: "slider-fill" });
    this.thumb = h("div", { class: "slider-thumb" });
    this.track = h("div", { class: "slider-track", role: "slider", tabindex: 0, "aria-label": this.label, "aria-valuemin": 0, "aria-valuemax": 100 }, this.fill, this.thumb);
    this.track.addEventListener("keydown", (e) => this.keyHandler(e));
    attachDrag(this.track, this, "x");
    this.value = this.valueField();
    this.root.append(h("div", { class: "ctl-row" }, h("div", { class: "ctl-label", text: this.label }), this.value), this.track);
  }
  update(v) {
    const n = this.model.toNorm(this.p.index, v);
    this.fill.style.width = (n * 100).toFixed(2) + "%";
    this.thumb.style.left = (n * 100).toFixed(2) + "%";
    this.value.textContent = this.text(v);
    this.aria(this.track, v);
  }
}

class Segmented extends Control {
  kind() { return "segmented"; }
  build() {
    const choices = this.p.choices || (this.p.type === "toggle" ? ["Off", "On"] : []);
    this.group = h("div", { class: "seg", role: "radiogroup", "aria-label": this.label });
    this.buttons = choices.map((c, i) =>
      h("button", { type: "button", class: "seg-btn", role: "radio", text: c, onclick: () => this.set(this.p.min + i) }));
    this.group.append(...this.buttons);
    this.group.addEventListener("keydown", (e) => this.keyHandler(e));
    this.root.append(h("div", { class: "ctl-label", text: this.label }), this.group);
  }
  update(v) {
    const idx = Math.round(v - this.p.min);
    this.buttons.forEach((b, i) => {
      b.setAttribute("aria-checked", i === idx ? "true" : "false");
      b.tabIndex = i === idx ? 0 : -1;
    });
  }
}

class Menu extends Control {
  kind() { return "menu"; }
  build() {
    this.select = h("select", { class: "menu-select", "aria-label": this.label, onchange: () => this.set(Number(this.select.value)) });
    const n = this.p.choices ? this.p.choices.length : this.steps + 1;
    for (let i = 0; i < n; i++) {
      const v = this.p.min + i * (this.p.step || 1);
      this.select.append(h("option", { value: v, text: this.p.choices ? this.p.choices[i] : this.text(v) }));
    }
    this.root.append(h("label", { class: "ctl-label", text: this.label }), this.select);
  }
  update(v) { this.select.value = String(Math.round(v)); }
}

class Toggle extends Control {
  kind() { return "toggle"; }
  build() {
    this.btn = h("button", { type: "button", class: "toggle", role: "switch", "aria-label": this.label, onclick: () => this.set(this.model.get(this.p.index) >= 0.5 ? 0 : 1) },
      h("span", { class: "toggle-knob" }));
    this.root.append(this.btn, h("div", { class: "ctl-label", text: this.label }));
  }
  update(v) { this.btn.setAttribute("aria-checked", v >= 0.5 ? "true" : "false"); }
}

// Two parameters on one pad: x = params[0], y = params[1].
class XYPad {
  constructor(app, px, py, opts = {}) {
    this.app = app; this.model = app.model; this.px = px; this.py = py;
    this.dot = h("div", { class: "xy-dot" });
    this.pad = h("div", { class: "xy-pad", role: "group", tabindex: 0, "aria-label": `${px.name} and ${py.name}` }, this.dot);
    this.readout = h("div", { class: "ctl-value is-static" });
    this.root = h("div", { class: "ctl ctl-xy" }, this.pad, h("div", { class: "ctl-label", text: opts.label || `${px.name} / ${py.name}` }), this.readout);
    const move = (e) => {
      const r = this.pad.getBoundingClientRect();
      this.model.setNorm(px.index, (e.clientX - r.left) / r.width, "ui");
      this.model.setNorm(py.index, 1 - (e.clientY - r.top) / r.height, "ui");
    };
    this.pad.addEventListener("pointerdown", (e) => { this.pad.setPointerCapture(e.pointerId); this.dragging = true; move(e); });
    this.pad.addEventListener("pointermove", (e) => { if (this.dragging) move(e); });
    this.pad.addEventListener("pointerup", () => { this.dragging = false; });
    this.pad.addEventListener("dblclick", () => { this.model.reset(px.index); this.model.reset(py.index); });
    this.pad.addEventListener("keydown", (e) => {
      const s = e.shiftKey ? 0.002 : 0.02;
      const map = { ArrowLeft: [px, -s], ArrowRight: [px, s], ArrowUp: [py, s], ArrowDown: [py, -s] };
      if (map[e.key]) { e.preventDefault(); const [p, d] = map[e.key]; this.model.setNorm(p.index, this.model.norm(p.index) + d, "ui"); }
    });
    this.model.on(px.index, () => this.update());
    this.model.on(py.index, () => this.update());
    this.update();
  }
  update() {
    const x = this.model.norm(this.px.index), y = this.model.norm(this.py.index);
    this.dot.style.left = x * 100 + "%";
    this.dot.style.top = (1 - y) * 100 + "%";
    this.readout.textContent = `${this.model.format(this.px.index)}, ${this.model.format(this.py.index)}`;
  }
}

function makeControl(app, param, spec = {}) {
  let type = spec.type;
  if (!type) {
    if (param.type === "toggle") type = "toggle";
    else if (param.type === "choice") type = (param.choices || []).length <= 4 ? "segmented" : "menu";
    else type = "knob";
  }
  const C = { knob: Knob, slider: Slider, segmented: Segmented, menu: Menu, toggle: Toggle }[type];
  if (!C) return null;
  return new C(app, param, spec);
}
