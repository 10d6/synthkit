// On-screen keyboard, pitch/mod wheels, and the computer keyboard:
//   A W S E D F T G Y H U J K O L P ; '  play notes
//   Z / X  octave down / up     C / V  velocity down / up
//   B / N / M  soft / sostenuto / sustain pedal (controllers.js)
// Clicking a key plays louder the nearer its front edge you press (like
// striking a real key further out), and where you let go is the key-up
// (release) velocity.

const SK_KEYMAP = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9,
  KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17,
};
const SK_BLACK = new Set([1, 3, 6, 8, 10]);

function skNoteName(n) { return ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"][n % 12] + (Math.floor(n / 12) - 1); }

class Keyboard {
  constructor(app) {
    this.app = app;
    this.base = skStore.get("synthkit:keyboard:base", 36);  // lowest C on screen
    this.typingOctave = skStore.get("synthkit:keyboard:typing", 60);
    this.velocity = skStore.get("synthkit:keyboard:velocity", 100);
    this.pointers = new Map();     // pointerId -> note
    this.typed = new Map();        // key code -> note
    this.keys = new Map();         // note -> element
    this.lit = new Map();          // note -> count of presses from the page (mouse, typing, a page's noteOn)
    this.midiLit = new Set();      // "channel:note" held on a MIDI controller (a set: repeated note-ons don't stack)
    this.vel = new Map();          // note -> velocity it was last played with (for the key's colour)
    this.typing = true;            // computer keys play notes (off on a page without the keyboard)
    this.build();
    document.addEventListener("keydown", (e) => this.key(e, true));
    document.addEventListener("keyup", (e) => this.key(e, false));
    window.addEventListener("blur", () => this.releaseTyped());
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.releaseTyped(); });
    new ResizeObserver(() => this.layout()).observe(this.keysEl);
  }

  build() {
    this.keysEl = h("div", { class: "keys", role: "group", "aria-label": "Keyboard" });
    this.range = h("span", { class: "kb-range" });
    this.velLabel = h("span", { class: "kb-vel" });
    const shift = (d) => { this.base = Math.min(96, Math.max(0, this.base + d)); skStore.set("synthkit:keyboard:base", this.base); this.layout(); };
    this.bend = this.wheel("Pitch bend", true, (v) => {
      const val = Math.round((v + 1) * 8191.5);
      this.app.sendMidi([0xe0, val & 127, (val >> 7) & 127]);
    });
    // The mod wheel is CC 1, sent like any controller; scrolling while the
    // pointer is over it moves it, as it does a knob.
    this.mod = this.wheel("Mod wheel", false, (v) => this.app.controlMidi([0xb0, 1, Math.round(v * 127)]), 127);
    this.controllers = new KeyboardControls(this.app);
    this.controlsOpen = skStore.get("synthkit:keyboard:controls", window.innerWidth > 720);
    this.controlsBtn = h("button", { type: "button", class: "btn btn-quiet kb-controls-btn", "aria-expanded": "false", onclick: () => this.showControls(!this.controlsOpen) }, "Controls");
    this.showControls(this.controlsOpen, false);
    this.root = h("div", { class: "keyboard" },
      h("div", { class: "kb-wheels" }, this.bend.root, this.mod.root),
      h("div", { class: "kb-main" },
        this.bar = h("div", { class: "kb-bar" },
          h("div", { class: "kb-octave" },
            h("button", { type: "button", class: "btn btn-icon", title: "Octave down", "aria-label": "Octave down", onclick: () => shift(-12) }, "‹"),
            this.range,
            h("button", { type: "button", class: "btn btn-icon", title: "Octave up", "aria-label": "Octave up", onclick: () => shift(12) }, "›")),
          this.controlsBtn,
          this.slot = h("div", { class: "kb-slot" }),
          h("span", { class: "kb-spacer" }),
          h("span", { class: "kb-hint", title: "Click a key near its front edge to play louder, near the back for softer; where you let go sets the key-up (release) velocity. Typing: Z / X shift the octave, C / V change velocity, B / N / M are the soft, sostenuto and sustain pedals." }, "Click lower on a key for louder · play with A–K"),
          this.velLabel),
        this.controllers.root,
        this.keysEl));
    this.keysEl.addEventListener("pointerdown", (e) => this.press(e));
    this.keysEl.addEventListener("pointermove", (e) => this.slide(e));
    for (const t of ["pointerup", "pointercancel", "pointerleave"]) this.keysEl.addEventListener(t, (e) => this.lift(e));
    this.showVelocity();
  }

  addToBar(...els) { if (this.slot.parentNode) this.slot.replaceWith(...els); }

  // steps: how many values the wheel sends (a CC's 127); it only sends when
  // the value changes by one of them. 0 sends every move.
  wheel(label, spring, send, steps = 0) {
    const thumb = h("div", { class: "wheel-thumb" });
    const el = h("div", { class: "wheel" + (spring ? " is-bend" : ""), role: "slider", tabindex: 0, "aria-label": label, "aria-valuemin": spring ? -1 : 0, "aria-valuemax": 1 }, thumb);
    const w = { value: spring ? 0 : 0, root: h("div", { class: "wheel-wrap" }, el, h("div", { class: "wheel-label", text: spring ? "Bend" : "Mod" })) };
    const quant = (v) => (steps ? Math.round(v * steps) : v);
    w.sent = 0;
    // silent: the synth already has this value (MIDI came in), only show it.
    const setv = (v, silent = false) => {
      v = Math.max(spring ? -1 : 0, Math.min(1, v));
      if (v === w.value) return;
      w.value = v;
      const n = spring ? (v + 1) / 2 : v;
      thumb.style.bottom = `calc(${(n * 100).toFixed(1)}% - ${(n * 14).toFixed(1)}px)`;
      el.setAttribute("aria-valuenow", v.toFixed(2));
      if (silent) w.sent = quant(v);
      else if (w.ready && quant(v) !== w.sent) { w.sent = quant(v); send(v); }
    };
    w.set = setv;
    // Follow MIDI that came from elsewhere, unless this wheel is being held,
    // and without moving it for a change smaller than one step.
    w.sync = (v) => {
      if (w.drag || (steps && quant(v) === quant(w.value))) return;
      setv(v, true);
    };
    if (!spring) {
      el.title = "Drag, or scroll while the pointer is over it (Shift for fine steps)";
      w.root.addEventListener("wheel", (e) => {
        e.preventDefault();
        // About twenty mouse-wheel notches end to end; trackpads move by how far they scroll.
        const d = e.deltaY || e.deltaX;
        const px = e.deltaMode === 1 ? d * 33 : e.deltaMode === 2 ? d * 400 : d;
        setv(w.value - (px / 100) * (e.shiftKey ? 0.01 : 0.05));
      }, { passive: false });
    }
    w.value = NaN;  // force the first draw
    setv(0);
    w.ready = true;
    const fromY = (e) => { const r = el.getBoundingClientRect(); const n = 1 - (e.clientY - r.top) / r.height; return spring ? n * 2 - 1 : n; };
    el.addEventListener("pointerdown", (e) => { el.setPointerCapture(e.pointerId); w.drag = true; setv(fromY(e)); });
    el.addEventListener("pointermove", (e) => { if (w.drag) setv(fromY(e)); });
    const up = () => { w.drag = false; if (spring) setv(0); };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp") { e.preventDefault(); setv(w.value + 0.05); }
      if (e.key === "ArrowDown") { e.preventDefault(); setv(w.value - 0.05); }
    });
    if (spring) el.addEventListener("keyup", (e) => { if (e.key.startsWith("Arrow")) setv(0); });
    return w;
  }

  showControls(open, save = true) {
    this.controlsOpen = open;
    this.controllers.root.hidden = !open;
    this.controlsBtn.setAttribute("aria-expanded", String(open));
    this.controlsBtn.classList.toggle("is-open", open);
    if (save) skStore.set("synthkit:keyboard:controls", open);   // only a choice is kept, not the starting default
  }
  // A page can leave the pedals and knobs out (API.md §9a).
  allowControls(on) {
    this.controlsBtn.hidden = !on;
    this.controllers.root.hidden = !on || !this.controlsOpen;
  }

  // MIDI the synth has just been given, from a MIDI controller or from one of
  // the page's own controls: the wheels, pedals and knobs show it.
  sync(d) {
    const type = d[0] & 0xf0;
    if (type === 0xb0) {
      if (d[1] === 1) this.mod.sync(d[2] / 127);
      this.controllers.syncCC(d[1], d[2]);
    } else if (type === 0xe0) this.bend.sync(Math.max(-1, Math.min(1, (((d[2] << 7) | d[1]) / 8191.5) - 1)));
    else if (type === 0xd0) this.controllers.syncPressure(d[1]);
  }

  layout() {
    // As many octaves as fit at a comfortable key width, up to five.
    const width = this.keysEl.clientWidth || 600;
    const octaves = Math.max(1, Math.min(5, Math.floor(width / (7 * (width < 520 ? 34 : 30)))));
    const low = this.base, high = Math.min(127, low + octaves * 12);
    this.keysEl.textContent = "";
    this.keys.clear();
    const wcount = [...Array(high - low + 1).keys()].filter((i) => !SK_BLACK.has((low + i) % 12)).length;
    let wi = 0;
    for (let n = low; n <= high; n++) {
      const black = SK_BLACK.has(n % 12);
      const k = h("div", { class: "key " + (black ? "key-black" : "key-white"), "data-note": n, "aria-label": skNoteName(n) });
      if (black) k.style.left = `calc(${(wi / wcount) * 100}% - var(--black-w) / 2)`;
      else {
        k.style.left = `${(wi / wcount) * 100}%`;
        k.style.width = `${100 / wcount}%`;
        if (n % 12 === 0) k.append(h("span", { class: "key-name", text: skNoteName(n) }));
        wi++;
      }
      if (this.isLit(n)) { k.classList.add("is-down"); k.style.setProperty("--kv", ((this.vel.get(n) || 100) / 127).toFixed(2)); }
      this.keysEl.append(k);
      this.keys.set(n, k);
    }
    this.range.textContent = `${skNoteName(low)} – ${skNoteName(high)}`;
  }

  // Velocity from where the pointer is on a key: nearer the front = louder.
  // The back fifth of a white key sits behind the black keys and plays
  // softest; the range is 20–127 so a soft click is still clearly audible.
  velocityFrom(e, key) {
    const r = key.getBoundingClientRect();
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / Math.max(1, r.height)));
    return Math.max(1, Math.min(127, Math.round(20 + y * 107)));
  }
  // Show the velocity a click played, then go back to the typing velocity.
  flashVelocity(v, up) {
    this.velLabel.textContent = up ? `Release ${v}` : `Velocity ${v}`;
    this.velLabel.classList.add("is-live");
    clearTimeout(this.velTimer);
    this.velTimer = setTimeout(() => { this.velLabel.classList.remove("is-live"); this.showVelocity(); }, 1500);
  }
  noteAt(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const key = el && el.closest && el.closest(".key");
    return key ? { note: Number(key.dataset.note), key } : null;
  }
  press(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const hit = this.noteAt(e);
    if (!hit) return;
    if (this.pointers.has(e.pointerId)) this.lift(e);   // pressed again without lifting: let go of the first
    this.pointers.set(e.pointerId, hit.note);
    const v = this.velocityFrom(e, hit.key);
    this.app.noteOn(hit.note, v);
    this.flashVelocity(v);
  }
  slide(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const hit = this.noteAt(e);
    const cur = this.pointers.get(e.pointerId);
    if (!hit || hit.note === cur) return;
    const v = this.velocityFrom(e, hit.key);
    this.app.noteOff(cur, v);
    this.pointers.set(e.pointerId, hit.note);
    this.app.noteOn(hit.note, v);
    this.flashVelocity(v);
  }
  lift(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const n = this.pointers.get(e.pointerId);
    // Key-up velocity from where the pointer lets go, on the key it was
    // playing (64, MIDI's "none", if it has left the keys).
    const key = this.keys.get(n);
    const r = key && key.getBoundingClientRect();
    const inside = r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    const v = inside ? this.velocityFrom(e, key) : 64;
    this.app.noteOff(n, v);
    if (inside && e.type === "pointerup") this.flashVelocity(v, true);
    this.pointers.delete(e.pointerId);
  }

  key(e, down) {
    // Letting go of a key always ends its note, whatever happened in between
    // (a modifier pressed, focus moved into a text field, typing turned off).
    if (!down && this.typed.has(e.code)) {
      this.app.noteOff(this.typed.get(e.code));
      this.typed.delete(e.code);
      return;
    }
    if (!down && this.controllers.keyUp(e.code)) return;   // same for a pedal key
    if (!this.typing) return;
    const t = e.target;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Text fields and lists keep their keys; a focused checkbox or slider doesn't need any.
    if (t && ((t.tagName === "INPUT" && !/^(checkbox|radio|button|range)$/.test(t.type)) || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    if (down && !e.repeat) {
      if (e.code === "KeyZ") { this.typingOctave = Math.max(0, this.typingOctave - 12); this.app.toast(`Typing keys start at ${skNoteName(this.typingOctave)}`); skStore.set("synthkit:keyboard:typing", this.typingOctave); return; }
      if (e.code === "KeyX") { this.typingOctave = Math.min(108, this.typingOctave + 12); this.app.toast(`Typing keys start at ${skNoteName(this.typingOctave)}`); skStore.set("synthkit:keyboard:typing", this.typingOctave); return; }
      if (e.code === "KeyC") { this.velocity = Math.max(10, this.velocity - 15); this.showVelocity(); return; }
      if (e.code === "KeyV") { this.velocity = Math.min(127, this.velocity + 15); this.showVelocity(); return; }
    }
    if (this.controllers.byKey.has(e.code)) { e.preventDefault(); if (down) this.controllers.key(e); return; }
    if (!(e.code in SK_KEYMAP)) return;
    // Arrow-key style focus on a control shouldn't swallow notes; but a focused
    // slider uses arrows, not letters, so letters always play.
    e.preventDefault();
    if (down) {
      if (e.repeat || this.typed.has(e.code)) return;
      const n = this.typingOctave + SK_KEYMAP[e.code];
      if (n > 127) return;
      this.typed.set(e.code, n);
      this.app.noteOn(n, this.velocity);
    } else if (this.typed.has(e.code)) {
      this.app.noteOff(this.typed.get(e.code));
      this.typed.delete(e.code);
    }
  }
  releaseTyped() {
    for (const n of this.typed.values()) this.app.noteOff(n);
    this.typed.clear();
    for (const n of this.pointers.values()) this.app.noteOff(n);
    this.pointers.clear();
    this.controllers.releaseHeld();
  }
  showVelocity() {
    this.velLabel.textContent = `Velocity ${this.velocity}`;
    skStore.set("synthkit:keyboard:velocity", this.velocity);
  }

  // Light keys for notes from the page (mouse, typing, a page's noteOn).
  // A lit key's colour follows the velocity it was played with.
  light(n, on, vel) {
    const c = (this.lit.get(n) || 0) + (on ? 1 : -1);
    if (c <= 0) this.lit.delete(n); else this.lit.set(n, c);
    if (on && vel) this.vel.set(n, vel);
    this.refresh(n);
  }
  // Keys held on a MIDI controller: per channel and note, so a repeated
  // note-on doesn't stack and a note-off always clears it.
  midiNote(channel, n, on, vel) {
    const id = `${channel}:${n}`;
    if (on) this.midiLit.add(id); else this.midiLit.delete(id);
    if (on && vel) this.vel.set(n, vel);
    this.refresh(n);
  }
  midiAllOff(channel) {
    for (const id of [...this.midiLit]) {
      const [c, n] = id.split(":").map(Number);
      if (channel === undefined || c === channel) { this.midiLit.delete(id); this.refresh(n); }
    }
  }
  isLit(n) {
    if (this.lit.get(n)) return true;
    for (const id of this.midiLit) if (Number(id.split(":")[1]) === n) return true;
    return false;
  }
  refresh(n) {
    const k = this.keys.get(n);
    if (!k) return;
    const lit = this.isLit(n);
    k.classList.toggle("is-down", lit);
    if (lit) k.style.setProperty("--kv", ((this.vel.get(n) || 100) / 127).toFixed(2));
  }
  // All notes off: let go of everything held on the page and clear the lights.
  clearLights() {
    this.typed.clear();
    this.pointers.clear();
    this.lit.clear();
    this.midiLit.clear();
    for (const k of this.keys.values()) k.classList.remove("is-down");
    this.controllers.reset();
  }
}
