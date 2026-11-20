// The keyboard's controls row: the three piano pedals and two assignable
// knobs. Everything here is MIDI the page makes itself, so it goes where a
// hardware controller's would (App.controlMidi: a CC learned to a control
// moves that control, a Learn waiting for a CC takes it) and follows
// hardware too (Keyboard.sync: a MIDI pedal lights its button).
//
//   B  soft pedal (CC 67)   N  sostenuto (CC 66)   M  sustain (CC 64)
//
// A pedal is down while you hold its button or key. With Latch on, a press
// toggles it instead: the way to hold one with a mouse that is also playing.
// A knob sends channel pressure (aftertouch) or any controller 0-119. Drag it
// (Shift for fine), scroll over it, or use the arrow keys.

const SK_PEDALS = [
  { cc: 67, name: "Soft", key: "KeyB", about: "Soft pedal (CC 67): softens the sound if the synth uses it." },
  { cc: 66, name: "Sostenuto", key: "KeyN", about: "Sostenuto pedal (CC 66): holds the notes sounding when it goes down; notes played after it are not held." },
  { cc: 64, name: "Sustain", key: "KeyM", about: "Sustain pedal (CC 64): holds notes after their keys come up." },
];
const SK_AFTERTOUCH = "at";
const SK_KNOB_DEFAULTS = [SK_AFTERTOUCH, 11];   // aftertouch, expression

class SkPedal {
  constructor(owner, def) {
    this.owner = owner;
    this.def = def;
    this.down = false;
    this.holder = null;     // what is holding it down (a pointer id or key code), when not latched
    this.latched = false;
    const letter = def.key.slice(3);
    this.btn = h("button", { type: "button", class: "btn pedal", "aria-pressed": "false", title: `${def.about} Key: ${letter}.` },
      h("span", { class: "pedal-name", text: def.name }),
      h("kbd", { class: "pedal-key", text: letter }));
    this.btn.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.btn.setPointerCapture(e.pointerId);
      owner.press(this, e.pointerId);
    });
    for (const t of ["pointerup", "pointercancel"]) this.btn.addEventListener(t, (e) => owner.lift(this, e.pointerId));
    // Space and Enter on the focused button hold the pedal like a click does.
    this.btn.addEventListener("keydown", (e) => {
      if (e.key !== " " && e.key !== "Enter") return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) owner.press(this, "button");
    });
    this.btn.addEventListener("keyup", (e) => { if (e.key === " " || e.key === "Enter") owner.lift(this, "button"); });
    this.btn.addEventListener("blur", () => owner.lift(this, "button"));
  }

  // silent: the synth already has this (MIDI came in), only show it.
  set(down, silent = false) {
    if (!down) { this.holder = null; this.latched = false; }
    if (down === this.down) return;
    this.down = down;
    this.btn.setAttribute("aria-pressed", String(down));
    this.btn.classList.toggle("is-down", down);
    if (!silent) this.owner.app.controlMidi([0xb0, this.def.cc, down ? 127 : 0]);
  }
}

// A knob that sends aftertouch or a controller. Its value is 0-127, kept as a
// 0-1 position so slow scrolling adds up between steps.
class SkCcKnob {
  constructor(owner, index, target) {
    this.owner = owner;
    this.index = index;
    this.target = target;
    this.norm = 0;
    this.sent = 0;
    this.root = h("div", { class: "kb-knob" });
    const s = svg("svg", { viewBox: "0 0 100 100", class: "knob-svg", "aria-hidden": "true" });
    s.append(svg("path", { class: "knob-track", d: arcPath(50, 50, 42, KNOB_START, KNOB_END) }));
    this.arc = svg("path", { class: "knob-arc" });
    s.append(this.arc, svg("circle", { class: "knob-cap", cx: 50, cy: 50, r: 31 }));
    this.pointer = svg("line", { class: "knob-pointer", x1: 50, y1: 50, x2: 50, y2: 23 });
    s.append(this.pointer);
    this.dial = h("div", { class: "knob-dial", role: "slider", tabindex: 0, "aria-valuemin": 0, "aria-valuemax": 127 }, s);
    this.value = h("span", { class: "kb-knob-value" });
    // A list keeps the computer keys for its own search, so let go of it once a choice is made.
    this.select = h("select", { class: "kb-assign", onchange: () => { this.assign(this.select.value === SK_AFTERTOUCH ? SK_AFTERTOUCH : Number(this.select.value)); this.select.blur(); } });
    this.fill();
    this.root.append(this.dial, h("div", { class: "kb-knob-side" }, this.select, this.value));

    // attachDrag (controls.js) moves anything with this much of a control's
    // shape: drag, Shift for fine, scroll, double-click to reset.
    this.ctl = {
      model: { gesture() {} }, p: { index: -1 }, root: this.root, stepScale: 1,
      norm: () => this.norm, setNorm: (n) => this.setNorm(n), focus: () => this.dial.focus(), reset: () => this.setNorm(0),
    };
    attachDrag(this.dial, this.ctl);
    this.dial.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 1 : e.key.startsWith("Page") ? 10 : 4;
      const keys = { ArrowUp: 1, ArrowRight: 1, PageUp: 1, ArrowDown: -1, ArrowLeft: -1, PageDown: -1 };
      if (e.key in keys) { e.preventDefault(); this.setNorm((Math.round(this.norm * 127) + keys[e.key] * step) / 127); }
      else if (e.key === "Home") { e.preventDefault(); this.setNorm(0); }
      else if (e.key === "End") { e.preventDefault(); this.setNorm(1); }
    });
    this.draw();
  }

  // The choices: aftertouch, then every controller by its MIDI name (the
  // mod matrix's own list, so the names match its source picker).
  fill() {
    const names = new Map();
    for (const src of this.owner.app.model.mod.sources) {
      const m = /^cc\.(\d+)$/.exec(src.id);
      if (m) names.set(Number(m[1]), src.name);
    }
    names.set(1, "CC 1 Mod Wheel");
    this.select.append(h("option", { value: SK_AFTERTOUCH, text: "Aftertouch" }));
    for (let n = 0; n < 120; n++) this.select.append(h("option", { value: n, text: names.get(n) || `CC ${n}` }));
    this.select.value = String(this.target);
    this.label();
  }
  label() {
    const name = this.target === SK_AFTERTOUCH ? "Aftertouch" : this.select.selectedOptions[0].textContent;
    this.dial.setAttribute("aria-label", name);
    this.select.setAttribute("aria-label", `Knob ${this.index + 1} sends`);
    this.root.title = `${name}. Drag, scroll or use the arrow keys; double-click to zero. ` +
      (this.target === SK_AFTERTOUCH ? "Aftertouch is a mod source." : "Right-click a control and choose MIDI learn, then move this, to map it; or pick it as a mod source.");
  }

  // Changing what a knob sends first puts the old target back to zero, so
  // nothing is left stuck at the last value.
  assign(target) {
    this.setNorm(0);
    this.target = target;
    this.sent = 0;
    this.label();
    this.owner.saveTargets();
  }

  setNorm(n) {
    this.norm = Math.min(1, Math.max(0, n));
    this.draw();
    const v = Math.round(this.norm * 127);
    if (v === this.sent) return;
    this.sent = v;
    this.owner.app.controlMidi(this.target === SK_AFTERTOUCH ? [0xd0, v] : [0xb0, this.target, v]);
  }
  // Show a value the synth already has (from MIDI), without sending it.
  sync(v) {
    if (v === Math.round(this.norm * 127)) return;
    this.norm = v / 127;
    this.sent = v;
    this.draw();
  }
  draw() {
    const a = KNOB_START + (KNOB_END - KNOB_START) * this.norm;
    this.arc.setAttribute("d", this.norm * 127 < 0.5 ? "" : arcPath(50, 50, 42, KNOB_START, a));
    this.pointer.setAttribute("transform", `rotate(${a.toFixed(1)} 50 50)`);
    const v = Math.round(this.norm * 127);
    this.value.textContent = String(v);
    this.dial.setAttribute("aria-valuenow", v);
  }
}

class KeyboardControls {
  constructor(app) {
    this.app = app;
    this.storeKey = `synthkit:${app.model.info.synth.id}:keyboardKnobs`;
    this.latch = skStore.get("synthkit:keyboard:latch", false);
    this.pedals = SK_PEDALS.map((d) => new SkPedal(this, d));
    this.byKey = new Map(this.pedals.map((p) => [p.def.key, p]));
    this.byCC = new Map(this.pedals.map((p) => [p.def.cc, p]));

    const saved = skStore.get(this.storeKey, []);
    const valid = (t) => t === SK_AFTERTOUCH || (Number.isInteger(t) && t >= 0 && t < 120);
    this.knobs = SK_KNOB_DEFAULTS.map((d, i) => new SkCcKnob(this, i, valid(saved[i]) ? saved[i] : d));

    this.latchBox = h("input", { type: "checkbox", checked: this.latch, onchange: () => this.setLatch(this.latchBox.checked) });
    this.root = h("div", { class: "kb-controls", role: "group", "aria-label": "Pedals and knobs" },
      h("div", { class: "kb-pedals" },
        ...this.pedals.map((p) => p.btn),
        h("label", { class: "kb-latch", title: "Latch: a press (click, or the key) toggles the pedal instead of holding it." }, this.latchBox, h("span", { text: "Latch" }))),
      h("div", { class: "kb-knobs" }, ...this.knobs.map((k) => k.root)));
  }

  press(p, source) {
    if (this.latch) {
      if (p.down) p.set(false);
      else { p.set(true); p.latched = true; }
      return;
    }
    p.holder = source;
    p.set(true);
  }
  lift(p, source) {
    if (this.latch || p.holder !== source) return;
    p.set(false);
  }
  setLatch(on) {
    this.latch = on;
    this.latchBox.checked = on;
    skStore.set("synthkit:keyboard:latch", on);
    // Turning Latch off lets go of what it was holding.
    if (!on) for (const p of this.pedals) if (p.latched) p.set(false);
  }

  // Computer keys: Keyboard.key hands over presses of the pedal keys; the key
  // coming up always arrives here, whatever else changed meanwhile.
  key(e) {
    const p = this.byKey.get(e.code);
    if (!p) return false;
    if (!e.repeat) this.press(p, e.code);
    return true;
  }
  keyUp(code) {
    const p = this.byKey.get(code);
    if (!p) return false;
    this.lift(p, code);
    return true;
  }
  // Focus left the page: whatever was only held (not latched) lets go.
  releaseHeld() {
    for (const p of this.pedals) if (p.down && !p.latched && p.holder !== null) p.set(false);
  }
  // Stop all sound: the synth let go of its pedals, so every one comes up.
  reset() {
    for (const p of this.pedals) p.set(false);
  }

  // What the synth has just been given.
  syncCC(cc, v) {
    const p = this.byCC.get(cc);
    if (p) p.set(v >= 64, true);
    else if (cc === 123) { for (const q of this.pedals) if (q.def.cc !== 67) q.set(false, true); }   // all notes off lifts sustain and sostenuto
    for (const k of this.knobs) if (k.target === cc) k.sync(v);
  }
  syncPressure(v) {
    for (const k of this.knobs) if (k.target === SK_AFTERTOUCH) k.sync(v);
  }
  saveTargets() { skStore.set(this.storeKey, this.knobs.map((k) => k.target)); }
}
