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

// Info icons: a small (i) beside a control's label or a panel's title. Its
// text shows in a popover while the mouse is over it or it has keyboard
// focus, and stays up after a click or tap until the next click elsewhere.
const skInfo = {
  pop: null, btn: null, pinned: false,
  init() {
    this.pop = h("div", { class: "info-pop", role: "tooltip", id: "sk-info-pop", hidden: true });
    document.body.append(this.pop);
    document.addEventListener("pointerdown", (e) => { if (this.btn && !this.btn.contains(e.target) && !this.pop.contains(e.target)) this.hide(); }, true);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") this.hide(); });
    window.addEventListener("scroll", () => { if (this.btn) this.place(); }, true);
    window.addEventListener("resize", () => this.hide());
  },
  show(btn, pinned) {
    if (!this.pop) this.init();
    if (this.btn && this.btn !== btn) this.release();
    this.btn = btn;
    this.pinned = pinned;
    this.pop.textContent = btn.skInfo;
    this.pop.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    btn.setAttribute("aria-describedby", this.pop.id);
    this.place();
  },
  place() {
    const r = this.btn.getBoundingClientRect(), p = this.pop, m = 8;
    if (!r.width) { this.hide(); return; }   // its panel was hidden
    p.style.left = "0px"; p.style.top = "0px";
    const w = p.offsetWidth, ht = p.offsetHeight;
    const x = Math.max(m, Math.min(window.innerWidth - w - m, r.left + r.width / 2 - w / 2));
    let y = r.bottom + 6;
    if (y + ht > window.innerHeight - m && r.top - 6 - ht >= m) y = r.top - 6 - ht;
    p.style.left = x.toFixed(0) + "px"; p.style.top = y.toFixed(0) + "px";
  },
  release() {
    this.btn.setAttribute("aria-expanded", "false");
    this.btn.removeAttribute("aria-describedby");
  },
  // hide(btn) only hides if btn is the one showing.
  hide(btn) {
    if (!this.btn || (btn && btn !== this.btn)) return;
    this.release();
    this.pop.hidden = true;
    this.btn = null;
    this.pinned = false;
  },
};

function skInfoButton(text, about) {
  const b = h("button", { type: "button", class: "info-btn", "aria-label": about ? `About ${about}` : "More information", "aria-expanded": "false" });
  const s = svg("svg", { viewBox: "0 0 16 16", "aria-hidden": "true" });
  s.append(svg("circle", { cx: 8, cy: 8, r: 6.6, class: "info-ring" }), svg("path", { d: "M8 7.2v4.4", class: "info-stem" }), svg("circle", { cx: 8, cy: 4.7, r: 1.05, class: "info-dot" }));
  b.append(s);
  b.skInfo = String(text);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    if (skInfo.btn === b && skInfo.pinned) skInfo.hide(); else skInfo.show(b, true);
  });
  b.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse" && !skInfo.pinned) skInfo.show(b, false); });
  b.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse" && !skInfo.pinned) skInfo.hide(b); });
  b.addEventListener("focus", () => { if (b.matches(":focus-visible") && !skInfo.pinned) skInfo.show(b, false); });
  b.addEventListener("blur", () => { if (!skInfo.pinned) skInfo.hide(b); });
  // Keys on the button belong to it, not to the computer keyboard's notes.
  b.addEventListener("keydown", (e) => e.stopPropagation());
  return b;
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
    ctl.model.gesture(ctl.p.index, true);
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
  const end = () => {
    if (start) ctl.model.gesture(ctl.p.index, false);
    start = null;
    ctl.root.classList.remove("is-active");
  };
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
    this.info = opts.info || (app.paramInfo && app.paramInfo[param.id]) || "";
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
  // The label under (or beside) a control, with its info icon if it has one.
  labelEl() {
    const el = h("div", { class: "ctl-label" }, this.label);
    if (this.info) el.append(skInfoButton(this.info, this.label));
    return el;
  }
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
    this.modArc = svg("path", { class: "knob-mod" });
    s.append(this.arc, this.modArc);
    s.append(svg("circle", { class: "knob-cap", cx: 50, cy: 50, r: 31 }));
    this.pointer = svg("line", { class: "knob-pointer", x1: 50, y1: 50, x2: 50, y2: 23 });
    s.append(this.pointer);
    this.dial = h("div", { class: "knob-dial", role: "slider", tabindex: 0, "aria-label": this.label, "aria-valuemin": 0, "aria-valuemax": 100 }, s);
    this.dial.addEventListener("keydown", (e) => this.keyHandler(e));
    attachDrag(this.dial, this);
    this.value = this.valueField();
    this.root.append(this.dial, this.labelEl(), this.value);
  }
  update(v) {
    const n = this.model.toNorm(this.p.index, v);
    const a = KNOB_START + (KNOB_END - KNOB_START) * n;
    const a0 = KNOB_START + (KNOB_END - KNOB_START) * this.origin;
    this.arc.setAttribute("d", Math.abs(a - a0) < 0.5 ? "" : arcPath(50, 50, 42, Math.min(a0, a), Math.max(a0, a)));
    this.pointer.setAttribute("transform", `rotate(${a.toFixed(1)} 50 50)`);
    this.value.textContent = this.text(v);
    this.aria(this.dial, v);
    this.base = v;
    if (this.modValue !== undefined) this.modulated(this.modValue);
  }
  // Live modulation: a thin outer arc from the set value to where modulation
  // has taken it (for the most recent voice).
  modulated(v) {
    this.modValue = v;
    if (Number.isNaN(v) || v === undefined) { this.modArc.setAttribute("d", ""); this.root.classList.remove("is-modulated"); return; }
    const a0 = KNOB_START + (KNOB_END - KNOB_START) * this.model.toNorm(this.p.index, this.model.get(this.p.index));
    const a1 = KNOB_START + (KNOB_END - KNOB_START) * this.model.toNorm(this.p.index, v);
    this.root.classList.add("is-modulated");
    this.modArc.setAttribute("d", Math.abs(a1 - a0) < 0.8 ? "" : arcPath(50, 50, 49, Math.min(a0, a1), Math.max(a0, a1)));
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
    this.root.append(h("div", { class: "ctl-row" }, this.labelEl(), this.value), this.track);
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
    this.root.append(this.labelEl(), this.group);
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
    this.root.append(this.labelEl(), this.select);
  }
  update(v) { this.select.value = String(Math.round(v)); }
}

class Toggle extends Control {
  kind() { return "toggle"; }
  build() {
    this.btn = h("button", { type: "button", class: "toggle", role: "switch", "aria-label": this.label, onclick: () => this.set(this.model.get(this.p.index) >= 0.5 ? 0 : 1) },
      h("span", { class: "toggle-knob" }));
    this.root.append(this.btn, this.labelEl());
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
    const label = opts.label || `${px.name} / ${py.name}`;
    const labelEl = h("div", { class: "ctl-label" }, label);
    if (opts.info) labelEl.append(skInfoButton(opts.info, label));
    this.root = h("div", { class: "ctl ctl-xy" }, this.pad, labelEl, this.readout);
    const move = (e) => {
      const r = this.pad.getBoundingClientRect();
      this.model.setNorm(px.index, (e.clientX - r.left) / r.width, "ui");
      this.model.setNorm(py.index, 1 - (e.clientY - r.top) / r.height, "ui");
    };
    this.pad.addEventListener("pointerdown", (e) => {
      this.pad.setPointerCapture(e.pointerId); this.dragging = true;
      this.model.gesture(px.index, true); this.model.gesture(py.index, true);
      move(e);
    });
    this.pad.addEventListener("pointermove", (e) => { if (this.dragging) move(e); });
    const up = () => {
      if (this.dragging) { this.model.gesture(px.index, false); this.model.gesture(py.index, false); }
      this.dragging = false;
    };
    this.pad.addEventListener("pointerup", up);
    this.pad.addEventListener("pointercancel", up);
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
