// Boot and glue: header (presets, tempo, MIDI, output), panels, keyboard,
// toasts and menus.

class App {
  constructor(model, wasmBytes, layout) {
    this.model = model;
    this.wasm = wasmBytes;
    this.layout = layout || {};
    this.audio = new Audio(wasmBytes);
    this.controls = [];
    this.widgets = new Map();
    this.transport = skStore.get("synthkit:transport", { bpm: 120, playing: false, num: 4, den: 4 });
    this.transport.playing = false;
  }

  boot(rootEl) {
    const m = this.model;
    const theme = this.layout.theme || {};
    if (theme.accent) document.documentElement.style.setProperty("--accent-base", theme.accent);
    const mode = skStore.get("synthkit:theme", "auto");
    if (mode !== "auto") document.documentElement.dataset.theme = mode;

    if (window.__skCustomRegister) {
      try { window.__skCustomRegister({ widget: (name, factory) => this.widgets.set(name, factory) }); }
      catch (err) { console.error(err); this.later(`ui/custom.js failed to load: ${err.message}`, "error"); }
    }

    this.presets = new PresetBar(this);
    this.midi = new MidiInput(this);
    this.keyboard = new Keyboard(this);
    const panels = new Panels(this);
    const panelEl = panels.build(this.layout.sections ? this.layout : null);

    this.toasts = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    this.banner = h("button", { type: "button", class: "start-banner", onclick: () => this.startAudio() },
      h("span", { class: "start-dot", "aria-hidden": "true" }),
      "Sound is off. Click here, or anywhere, to start it.");

    rootEl.append(
      this.header(),
      this.banner,
      h("main", { class: "main" }, panelEl),
      this.layout.keyboard === false ? null : this.keyboard.root,
      this.toasts);
    rootEl.removeAttribute("aria-busy");
    this.keyboard.layout();

    this.presets.restoreSession();
    this.refreshLearned();
    for (const p of panels.problems.concat(this.pending || [])) this.toast(p.msg || p, p.kind || "warn");

    // Browsers only allow audio after the first click or key press.
    const kick = () => { this.startAudio(); };
    document.addEventListener("pointerdown", kick, { once: true, capture: true });
    document.addEventListener("keydown", kick, { once: true, capture: true });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") { this.midi.cancelLearn(); this.closeMenu(); } });

    this.audio.onMeter = (mtr) => this.meter(mtr);
    this.audio.onLog = (msg) => this.toast(msg, "error");
    for (const l of m.logs) this.toast(l, "error");
  }

  later(msg, kind) { (this.pending = this.pending || []).push({ msg, kind }); }

  async startAudio() {
    if (this.audio.running) return;
    try {
      await this.audio.start(this.model, this.transport);
      this.model.sink = this.audio.sink();
      this.banner.hidden = true;
      this.sendTransport();
    } catch (err) {
      console.error(err);
      this.toast(`Audio couldn't start: ${err.message}`, "error");
    }
  }

  sendMidi(bytes) {
    if (!this.audio.node) { this.startAudio().then(() => this.audio.midi(bytes)); return; }
    this.audio.midi(bytes);
  }
  noteOn(n, v) { this.keyboard.light(n, true); this.sendMidi([0x90, n, v]); }
  noteOff(n) { this.keyboard.light(n, false); this.sendMidi([0x80, n, 64]); }

  // ---- header --------------------------------------------------------------

  header() {
    const info = this.model.info.synth;
    const t = this.transport;
    this.bpm = h("input", { class: "bpm-input", type: "number", min: 30, max: 300, step: 1, value: t.bpm, "aria-label": "Tempo in BPM" });
    this.bpm.addEventListener("change", () => {
      const v = Math.min(300, Math.max(30, Number(this.bpm.value) || 120));
      this.bpm.value = v; t.bpm = v; this.sendTransport();
    });
    this.bpm.addEventListener("keydown", (e) => e.stopPropagation());
    this.sig = h("select", { class: "sig-select", "aria-label": "Time signature", onchange: () => {
      const [n, d] = this.sig.value.split("/").map(Number); t.num = n; t.den = d; this.buildBeats(); this.sendTransport();
    } }, ...["2/4", "3/4", "4/4", "5/4", "6/8", "7/8", "12/8"].map((s) => h("option", { value: s, text: s })));
    this.sig.value = `${t.num}/${t.den}`;
    this.play = h("button", { type: "button", class: "btn play-btn", "aria-pressed": "false", title: "Start the tempo clock (space)", onclick: () => this.togglePlay() }, "Play");
    document.addEventListener("keydown", (e) => {
      if (e.code === "Space" && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(e.target.tagName)) { e.preventDefault(); this.togglePlay(); }
    });
    this.beats = h("div", { class: "beats", "aria-hidden": "true" });
    this.buildBeats();

    this.scope = h("canvas", { class: "scope", width: 240, height: 64, "aria-label": "Output waveform", role: "img" });
    this.levelFill = h("div", { class: "level-fill" });
    this.levelEl = h("div", { class: "level", "aria-hidden": "true" }, this.levelFill);
    this.voices = h("span", { class: "voice-count", text: "0 voices" });
    const panic = h("button", { type: "button", class: "btn btn-quiet", title: "Silence everything right now", onclick: () => { this.audio.send({ t: "panic" }); this.keyboard.clearLights(); } }, "Stop all sound");
    const icon = svg("svg", { viewBox: "0 0 16 16", width: 16, height: 16, "aria-hidden": "true" });
    icon.append(svg("circle", { cx: 8, cy: 8, r: 6.25, fill: "none", stroke: "currentColor", "stroke-width": 1.5 }),
                svg("path", { d: "M8 1.75 A6.25 6.25 0 0 1 8 14.25 Z", fill: "currentColor" }));
    const themeBtn = h("button", { type: "button", class: "btn btn-quiet btn-icon theme-btn", title: "Switch light / dark", "aria-label": "Switch light or dark theme", onclick: () => this.cycleTheme() }, icon);

    // Playing controls (tempo, MIDI) live with the keyboard.
    this.keyboard.addToBar(
      h("div", { class: "tempo" }, this.play, h("label", { class: "bpm" }, this.bpm, h("span", { text: "BPM" })), this.sig, this.beats),
      this.midi.root);
    return h("header", { class: "top" },
      h("div", { class: "brand" },
        h("h1", { class: "synth-name", text: info.name }),
        h("span", { class: "synth-meta", text: [info.vendor, info.version && "v" + info.version].filter(Boolean).join(" ") })),
      this.presets.root,
      h("div", { class: "output" }, this.scope, h("div", { class: "output-side" }, this.levelEl, this.voices)),
      h("div", { class: "top-actions" }, panic, themeBtn));
  }

  buildBeats() {
    this.beats.textContent = "";
    for (let i = 0; i < this.transport.num; i++) this.beats.append(h("span", { class: "beat" + (i === 0 ? " is-down" : "") }));
  }

  togglePlay() {
    this.transport.playing = !this.transport.playing;
    this.play.setAttribute("aria-pressed", String(this.transport.playing));
    this.play.textContent = this.transport.playing ? "Stop" : "Play";
    this.startAudio().then(() => this.sendTransport());
  }

  sendTransport() {
    const t = this.transport;
    skStore.set("synthkit:transport", { bpm: t.bpm, num: t.num, den: t.den });
    this.audio.send({ t: "transport", bpm: t.bpm, playing: t.playing, num: t.num, den: t.den });
  }

  cycleTheme() {
    const order = ["auto", "light", "dark"];
    const cur = document.documentElement.dataset.theme || "auto";
    const next = order[(order.indexOf(cur) + 1) % order.length];
    if (next === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    skStore.set("synthkit:theme", next);
    this.toast(next === "auto" ? "Theme follows your system" : `${next[0].toUpperCase() + next.slice(1)} theme`);
  }

  meter(mtr) {
    this.voices.textContent = `${mtr.voices} ${mtr.voices === 1 ? "voice" : "voices"}`;
    const db = mtr.peak > 0 ? 20 * Math.log10(mtr.peak) : -100;
    const n = Math.max(0, Math.min(1, (db + 48) / 48));
    this.levelFill.style.width = (n * 100).toFixed(1) + "%";
    this.levelEl.classList.toggle("is-hot", mtr.limiterDb > 0.5);
    const beats = [...this.beats.children];
    const per = (4 / this.transport.den);
    const idx = mtr.playing ? Math.floor(mtr.beat / per) % this.transport.num : -1;
    beats.forEach((b, i) => b.classList.toggle("is-on", i === idx));
    this.drawScope(mtr.scope);
  }

  drawScope(data) {
    const c = this.scope, g = c.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, hgt = c.clientHeight;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(hgt * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    // Start at a rising zero crossing so periodic waves stand still.
    let s = 0;
    for (let i = 1; i < data.length / 2; i++) if (data[i - 1] <= 0 && data[i] > 0) { s = i; break; }
    const n = Math.min(512, data.length - s);
    g.strokeStyle = getComputedStyle(c).color;
    g.lineWidth = 1.5;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w, y = hgt / 2 - data[s + i] * (hgt / 2 - 3);
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.stroke();
  }

  // ---- menus, toasts, learn ------------------------------------------------

  paramMenu(ctl, x, y) {
    const cc = this.midi.ccFor(ctl.p.id);
    const learning = this.midi.learning === ctl.p.id;
    this.menu(x, y, [
      { label: `Reset to ${this.model.format(ctl.p.index, ctl.p.def)}`, run: () => ctl.reset() },
      learning ? { label: "Stop MIDI learn", run: () => this.midi.cancelLearn() } : { label: "MIDI learn", run: () => this.midi.learn(ctl) },
      cc !== null ? { label: `Forget CC ${cc}`, run: () => this.midi.forget(ctl.p.id) } : null,
    ].filter(Boolean));
  }

  refreshLearned() { for (const c of this.controls) c.learned(this.midi.ccFor(c.p.id)); }

  menu(x, y, items) {
    this.closeMenu();
    const list = h("div", { class: "menu", role: "menu" });
    for (const it of items) {
      if (!it) { list.append(h("div", { class: "menu-sep", role: "separator" })); continue; }
      list.append(h("button", { type: "button", class: "menu-item", role: "menuitem", disabled: it.disabled, onclick: () => { this.closeMenu(); it.run(); } }, it.label));
    }
    document.body.append(list);
    const r = list.getBoundingClientRect();
    list.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + "px";
    list.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + "px";
    this.openMenu = list;
    const first = list.querySelector("button:not([disabled])");
    if (first) first.focus();
    setTimeout(() => {
      this.menuAway = (e) => { if (!list.contains(e.target)) this.closeMenu(); };
      document.addEventListener("pointerdown", this.menuAway, true);
    });
  }
  closeMenu() {
    if (this.openMenu) this.openMenu.remove();
    this.openMenu = null;
    if (this.menuAway) document.removeEventListener("pointerdown", this.menuAway, true);
  }

  toast(msg, kind = "info") {
    const t = h("div", { class: "toast is-" + kind, text: msg });
    this.toasts.append(t);
    while (this.toasts.children.length > 4) this.toasts.firstChild.remove();
    setTimeout(() => t.remove(), kind === "error" ? 9000 : 3500);
  }

  // ---- custom widgets (ui/custom.js) ---------------------------------------

  customWidget(spec) {
    const el = h("div", { class: "ctl ctl-custom" });
    const m = this.model;
    const ctx = {
      spec,
      param: (id) => m.param(id),
      get: (id) => m.get(id),
      set: (id, v) => m.set(id, v, "ui"),
      format: (id, v) => m.format(id, v),
      onParam: (id, fn) => { const off = m.on(id, fn); fn(m.get(id)); return off; },
      custom: (id) => m.custom(id),
      setCustom: (id, v) => m.setCustom(id, v),
      onCustom: (id, fn) => { const off = m.onCustom(id, fn); fn(m.custom(id)); return off; },
      onMeter: () => () => {},  // mod-source meters arrive in phase 4
      noteOn: (n, v = 100) => this.noteOn(n, v),
      noteOff: (n) => this.noteOff(n),
    };
    try { this.widgets.get(spec.type)(el, ctx); }
    catch (err) { console.error(err); el.textContent = `Widget "${spec.type}" failed: ${err.message}`; el.classList.add("is-broken"); }
    return el;
  }
}

// ---- boot ---------------------------------------------------------------------

(async () => {
  const root = document.getElementById("app");
  try {
    const data = JSON.parse(document.getElementById("sk-data").textContent);
    const bytes = skBase64ToBytes(data.wasm);
    const model = await Model.create(bytes);
    document.title = model.info.synth.name;
    const app = new App(model, bytes, data.layout);
    app.boot(root);
    window.synthkit = {
      app,
      model,
      renderOffline: (opts = {}) => Audio.renderOffline(bytes, {
        patch: JSON.stringify(model.savePatch()), custom: model.customSnapshot(), ...opts }),
    };
  } catch (err) {
    console.error(err);
    root.removeAttribute("aria-busy");
    root.append(h("div", { class: "fatal" },
      h("h1", { text: "This synth couldn't start" }),
      h("p", { text: String(err && err.message || err) }),
      h("p", { text: "Try a recent Chrome, Edge, Firefox or Safari. If it keeps happening, the browser console has the details." })));
  }
})();
