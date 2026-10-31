// On-screen keyboard, pitch/mod wheels, and the computer keyboard:
//   A W S E D F T G Y H U J K O L P ; '  play notes
//   Z / X  octave down / up     C / V  velocity down / up

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
    this.lit = new Map();          // note -> count (all sources)
    this.typing = true;            // computer keys play notes (off on a page without the keyboard)
    this.build();
    document.addEventListener("keydown", (e) => this.key(e, true));
    document.addEventListener("keyup", (e) => this.key(e, false));
    window.addEventListener("blur", () => this.releaseTyped());
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
    this.mod = this.wheel("Mod wheel", false, (v) => this.app.sendMidi([0xb0, 1, Math.round(v * 127)]));
    this.root = h("div", { class: "keyboard" },
      h("div", { class: "kb-wheels" }, this.bend.root, this.mod.root),
      h("div", { class: "kb-main" },
        this.bar = h("div", { class: "kb-bar" },
          h("div", { class: "kb-octave" },
            h("button", { type: "button", class: "btn btn-icon", title: "Octave down", "aria-label": "Octave down", onclick: () => shift(-12) }, "‹"),
            this.range,
            h("button", { type: "button", class: "btn btn-icon", title: "Octave up", "aria-label": "Octave up", onclick: () => shift(12) }, "›")),
          this.slot = h("div", { class: "kb-slot" }),
          h("span", { class: "kb-spacer" }),
          h("span", { class: "kb-hint", title: "Z / X shift the octave, C / V change velocity" }, "Play with A–K on your keyboard"),
          this.velLabel),
        this.keysEl));
    this.keysEl.addEventListener("pointerdown", (e) => this.press(e));
    this.keysEl.addEventListener("pointermove", (e) => this.slide(e));
    for (const t of ["pointerup", "pointercancel", "pointerleave"]) this.keysEl.addEventListener(t, (e) => this.lift(e));
    this.showVelocity();
  }

  addToBar(...els) { if (this.slot.parentNode) this.slot.replaceWith(...els); }

  wheel(label, spring, send) {
    const thumb = h("div", { class: "wheel-thumb" });
    const el = h("div", { class: "wheel" + (spring ? " is-bend" : ""), role: "slider", tabindex: 0, "aria-label": label, "aria-valuemin": spring ? -1 : 0, "aria-valuemax": 1 }, thumb);
    const w = { value: spring ? 0 : 0, root: h("div", { class: "wheel-wrap" }, el, h("div", { class: "wheel-label", text: spring ? "Bend" : "Mod" })) };
    const setv = (v) => {
      v = Math.max(spring ? -1 : 0, Math.min(1, v));
      if (v === w.value) return;
      w.value = v;
      const n = spring ? (v + 1) / 2 : v;
      thumb.style.bottom = `calc(${(n * 100).toFixed(1)}% - ${(n * 14).toFixed(1)}px)`;
      el.setAttribute("aria-valuenow", v.toFixed(2));
      if (w.ready) send(v);
    };
    w.set = setv;
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
      if (this.lit.get(n)) k.classList.add("is-down");
      this.keysEl.append(k);
      this.keys.set(n, k);
    }
    this.range.textContent = `${skNoteName(low)} – ${skNoteName(high)}`;
  }

  velocityFrom(e, key) {
    const r = key.getBoundingClientRect();
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    return Math.round(40 + y * 87);  // nearer the front of the key = louder
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
    this.pointers.set(e.pointerId, hit.note);
    this.app.noteOn(hit.note, this.velocityFrom(e, hit.key));
  }
  slide(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const hit = this.noteAt(e);
    const cur = this.pointers.get(e.pointerId);
    if (!hit || hit.note === cur) return;
    this.app.noteOff(cur);
    this.pointers.set(e.pointerId, hit.note);
    this.app.noteOn(hit.note, this.velocityFrom(e, hit.key));
  }
  lift(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.app.noteOff(this.pointers.get(e.pointerId));
    this.pointers.delete(e.pointerId);
  }

  key(e, down) {
    if (!this.typing) return;
    const t = e.target;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    if (down && !e.repeat) {
      if (e.code === "KeyZ") { this.typingOctave = Math.max(0, this.typingOctave - 12); this.app.toast(`Typing keys start at ${skNoteName(this.typingOctave)}`); skStore.set("synthkit:keyboard:typing", this.typingOctave); return; }
      if (e.code === "KeyX") { this.typingOctave = Math.min(108, this.typingOctave + 12); this.app.toast(`Typing keys start at ${skNoteName(this.typingOctave)}`); skStore.set("synthkit:keyboard:typing", this.typingOctave); return; }
      if (e.code === "KeyC") { this.velocity = Math.max(10, this.velocity - 15); this.showVelocity(); return; }
      if (e.code === "KeyV") { this.velocity = Math.min(127, this.velocity + 15); this.showVelocity(); return; }
    }
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
  }
  showVelocity() {
    this.velLabel.textContent = `Velocity ${this.velocity}`;
    skStore.set("synthkit:keyboard:velocity", this.velocity);
  }

  // Light keys for notes from any source (mouse, typing, MIDI).
  light(n, on) {
    const c = (this.lit.get(n) || 0) + (on ? 1 : -1);
    if (c <= 0) this.lit.delete(n); else this.lit.set(n, c);
    const k = this.keys.get(n);
    if (k) k.classList.toggle("is-down", c > 0);
  }
  clearLights() {
    this.lit.clear();
    for (const k of this.keys.values()) k.classList.remove("is-down");
  }
}
