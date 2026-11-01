// Boot and glue: header (presets, tempo, MIDI, output), panels, keyboard,
// toasts and menus.

class App {
  constructor(model, wasmBytes, layout) {
    this.model = model;
    this.wasm = wasmBytes;
    this.layout = layout || {};
    this.host = skHost;          // set when running inside the plugin
    this.audio = skHost ? new HostAudio() : new Audio(wasmBytes);
    this.controls = [];
    this.widgets = new Map();
    this.transport = skStore.get("synthkit:transport", { bpm: 120, playing: false, num: 4, den: 4 });
    this.transport.playing = false;
    this.transportSubs = new Set();
    this.modMeters = new ModMeters(model);
    this.clock = new MidiClock(this);
    this.clockSource = skStore.get("synthkit:clock", "internal");
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

    // Messages to and from the synth (API.md §9b).
    this.messageIds = m.info.messages || [];
    this.messageSubs = new Map();
    this.midiTaps = new Set();        // a page taking MIDI messages (sk.takeMidi)
    this.midiListeners = new Set();   // a page listening to MIDI (sk.onMidi)
    this.spacePlays = true;           // Space starts the tempo clock (a page can turn it off)

    this.presets = new PresetBar(this);
    this.midi = new MidiInput(this);
    this.keyboard = new Keyboard(this);
    this.buildParts();

    this.toasts = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    this.banner = h("button", { type: "button", class: "start-banner", onclick: () => this.startAudio() },
      h("span", { class: "start-dot", "aria-hidden": "true" }),
      "Sound is off. Click here, or anywhere, to start it.");

    // A synth with ui/page.js brings its own page (API.md §9a); otherwise the
    // kit builds the standard one from layout.json.
    const ownPage = typeof window.__skPage === "function" ? window.__skPage : null;
    const problems = [];
    if (!ownPage) {
      const panels = new Panels(this);
      const panelEl = panels.build(this.layout.sections ? this.layout : null);
      problems.push(...panels.problems);
      rootEl.append(
        this.header(),
        this.banner,
        h("main", { class: "main" }, panelEl),
        this.layout.keyboard === false ? null : this.keyboard.root,
        this.toasts);
      if (this.layout.keyboard === false) this.keyboard.typing = false;
    } else {
      this.keyboard.typing = false;   // until the page mounts the keyboard
      rootEl.classList.add("sk-own-page");
      rootEl.append(this.toasts);
    }
    rootEl.removeAttribute("aria-busy");
    this.keyboard.layout();

    // Tempo saved in patches (features.tempoInPatch): a patch that has one
    // sets the browser's tempo controls.
    this.tempoInPatch = !!m.info.synth.tempoInPatch;
    m.onPatch(() => this.applyPatchTempo());
    // Parameters the engine moved (mapped MIDI controllers, ctx.setParam).
    this.audio.onParams = (changes) => { for (const [i, v] of changes) this.model.applyHost(i, v); };

    this.presets.restoreSession();
    if (this.host) {
      // The plugin makes the sound: changes go straight to it.
      this.model.sink = this.audio.sink();
      this.banner.hidden = true;
      this.audio.onHost = (msg) => this.hostMessage(msg);
    }
    this.audio.onMessages = (list) => this.receiveMessages(list);

    if (ownPage) {
      const pageRoot = h("div", { class: "sk-page" });
      const tpl = document.getElementById("sk-page-html");
      if (tpl) pageRoot.append(tpl.content.cloneNode(true));
      rootEl.prepend(pageRoot);
      this.pageProblems = problems;
      try { ownPage(this.pageApi(), pageRoot); }
      catch (err) { console.error(err); problems.push({ msg: `ui/page.js failed: ${err.message}`, kind: "error" }); }
      this.buildHostBar(pageRoot);
    }

    this.refreshLearned();
    // Live modulation rings on knobs.
    const ringed = this.controls.filter((c) => c.modulated && !c.ringed);
    for (const c of ringed) c.ringed = true;
    this.modMeters.on((mm) => { for (const c of ringed) c.modulated(mm.active ? mm.param(c.p.index) : NaN); });
    this.pageProblems = null;
    for (const p of problems.concat(this.pending || [])) this.toast(p.msg || p, p.kind || "warn");

    // Browsers only allow audio during a click or key press: every one starts
    // (or resumes) it until it's running.
    const kick = () => { if (!this.audio.running) this.startAudio(); };
    document.addEventListener("pointerdown", kick, { capture: true });
    document.addEventListener("keydown", kick, { capture: true });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") { this.midi.cancelLearn(); this.closeMenu(); } });

    if (this.clockSource === "midi" && !this.host) this.setClockSource("midi");
    this.audio.onMeter = (mtr) => this.meter(mtr);
    this.audio.onLog = (msg, kind) => this.toast(msg, kind || "error");
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

  // Messages from the plugin (see host.js).
  hostMessage(m) {
    if (m.t === "params") { for (const [i, v] of m.changes || []) this.model.applyHost(i, v); }
    else if (m.t === "state") this.presets.applyHostState(m.patch, m.ui);
    else if (m.t === "store") skStore.external(m.key, m.value);
    else if (m.t === "imported") this.presets.importText(m.text, m.file);
  }

  sendMidi(bytes) {
    if (!this.audio.node) { this.startAudio().then(() => this.audio.midi(bytes)); return; }
    this.audio.midi(bytes);
  }
  noteOn(n, v) { this.keyboard.light(n, true); this.sendMidi([0x90, n, v]); }
  noteOff(n) { this.keyboard.light(n, false); this.sendMidi([0x80, n, 64]); }

  // ---- messages (API.md §9b) -----------------------------------------------

  sendMessage(id, values = []) {
    const i = this.messageIds.indexOf(id);
    if (i < 0) { console.warn(`[synthkit] no message "${id}" (declare it in defineMessages)`); return false; }
    const v = Array.from(values, Number).slice(0, 4);
    if (!this.audio.node) { this.startAudio().then(() => this.audio.send({ t: "msg", i, v })); return true; }
    this.audio.send({ t: "msg", i, v });
    return true;
  }
  onMessage(id, fn) {
    if (!this.messageSubs.has(id)) this.messageSubs.set(id, new Set());
    this.messageSubs.get(id).add(fn);
    return () => this.messageSubs.get(id).delete(fn);
  }
  receiveMessages(list) {
    for (const [i, v] of list) {
      const id = this.messageIds[i];
      for (const fn of this.messageSubs.get(id) || []) {
        try { fn(...v); } catch (err) { console.error(err); }
      }
    }
  }
  // MIDI from Web MIDI, before the synth sees it. Listeners (sk.onMidi) see
  // every message; a taker (sk.takeMidi) returning true takes it, and the
  // synth doesn't get it.
  tapMidi(d) {
    for (const fn of this.midiListeners) { try { fn(d); } catch (err) { console.error(err); } }
    for (const fn of this.midiTaps) { try { if (fn(d) === true) return true; } catch (err) { console.error(err); } }
    return false;
  }

  // ---- header --------------------------------------------------------------

  // The header's parts, built once: the default page places them, and a
  // synth's own page can mount them (API.md §9a).
  buildParts() {
    const t = this.transport;
    this.bpm = h("input", { class: "bpm-input", type: "number", min: 30, max: 300, step: 1, value: t.bpm, "aria-label": "Tempo in BPM" });
    this.bpm.addEventListener("change", () => {
      const v = Math.min(300, Math.max(30, Number(this.bpm.value) || 120));
      this.bpm.value = v; t.bpm = v; this.sendTransport(); this.recordTempo();
    });
    this.bpm.addEventListener("keydown", (e) => e.stopPropagation());
    this.sig = h("select", { class: "sig-select", "aria-label": "Time signature", onchange: () => {
      const [n, d] = this.sig.value.split("/").map(Number); t.num = n; t.den = d; this.buildBeats(); this.sendTransport(); this.recordTempo();
      for (const fn of this.transportSubs) fn(t);
    } }, ...["2/4", "3/4", "4/4", "5/4", "6/8", "7/8", "12/8"].map((s) => h("option", { value: s, text: s })));
    this.clockSel = h("select", { class: "sig-select", "aria-label": "Tempo source", onchange: () => this.setClockSource(this.clockSel.value) },
      h("option", { value: "internal", text: "Internal" }), h("option", { value: "midi", text: "MIDI clock" }));
    this.clockSel.value = this.clockSource;
    this.sig.value = `${t.num}/${t.den}`;
    this.play = h("button", { type: "button", class: "btn play-btn", "aria-pressed": "false", title: "Start the tempo clock (space)", onclick: () => this.togglePlay() }, "Play");
    document.addEventListener("keydown", (e) => {
      if (this.host || !this.tempoShown || !this.spacePlays) return;   // the DAW's transport, no tempo on the page, or the page uses Space
      if (e.code === "Space" && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(e.target.tagName)) { e.preventDefault(); this.togglePlay(); }
    });
    this.beats = h("div", { class: "beats", "aria-hidden": "true" });
    this.buildBeats();

    this.scope = h("canvas", { class: "scope", width: 240, height: 64, "aria-label": "Output waveform", role: "img" });
    this.levelFill = h("div", { class: "level-fill" });
    this.levelEl = h("div", { class: "level", "aria-hidden": "true" }, this.levelFill);
    this.voices = h("span", { class: "voice-count", text: "0 voices" });
    this.panicBtn = h("button", { type: "button", class: "btn btn-quiet", title: "Silence everything right now", onclick: () => this.panic() }, "Stop all sound");
    const icon = svg("svg", { viewBox: "0 0 16 16", width: 16, height: 16, "aria-hidden": "true" });
    icon.append(svg("circle", { cx: 8, cy: 8, r: 6.25, fill: "none", stroke: "currentColor", "stroke-width": 1.5 }),
                svg("path", { d: "M8 1.75 A6.25 6.25 0 0 1 8 14.25 Z", fill: "currentColor" }));
    this.themeBtn = h("button", { type: "button", class: "btn btn-quiet btn-icon theme-btn", title: "Switch light / dark", "aria-label": "Switch light or dark theme", onclick: () => this.cycleTheme() }, icon);
    this.tempoReadout = h("span", { class: "tempo-readout", text: "" });
    this.outputEl = h("div", { class: "output" }, this.scope, h("div", { class: "output-side" }, this.levelEl, this.voices));
  }

  // Tempo controls (play, BPM, signature, clock source, beat lights); in the
  // plugin, a readout of the DAW's tempo.
  tempoEl() {
    this.tempoShown = true;
    if (this.host) return h("div", { class: "tempo is-host", title: "Tempo and time signature come from your DAW" }, this.tempoReadout, this.beats);
    return h("div", { class: "tempo" }, this.play, h("label", { class: "bpm" }, this.bpm, h("span", { text: "BPM" })), this.sig, this.clockSel, this.beats);
  }

  panic() { this.audio.send({ t: "panic" }); this.keyboard.clearLights(); }

  header() {
    const info = this.model.info.synth;
    // Playing controls (tempo, MIDI) live with the keyboard. In the plugin the
    // DAW sets the tempo, so they become a readout.
    if (this.host) this.keyboard.addToBar(this.tempoEl());
    else this.keyboard.addToBar(this.tempoEl(), this.midi.root);
    return h("header", { class: "top" },
      h("div", { class: "brand" },
        h("h1", { class: "synth-name", text: info.name }),
        h("span", { class: "synth-meta", text: [info.vendor, info.version && "v" + info.version].filter(Boolean).join(" ") })),
      this.presets.root,
      this.outputEl,
      h("div", { class: "top-actions" }, this.panicBtn, this.themeBtn));
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
    this.audio.send({ t: "transport", bpm: t.bpm, playing: t.playing, num: t.num, den: t.den, source: this.clockSource === "midi" ? "midi" : "internal" });
  }

  // Tempo in patches (features.tempoInPatch): the tempo controls write the
  // patch's tempo, and loading a patch with one sets them.
  recordTempo() {
    if (!this.tempoInPatch || this.host) return;
    const t = this.transport;
    this.model.setPatchTempo(t.bpm, t.num, t.den);
  }
  applyPatchTempo() {
    if (!this.tempoInPatch || this.host || this.clockSource === "midi") return;
    const pt = this.model.patchTempo();
    if (!pt) return;
    const t = this.transport;
    if (t.bpm === pt.bpm && t.num === pt.num && t.den === pt.den) return;
    t.bpm = pt.bpm; t.num = pt.num; t.den = pt.den;
    if (this.bpm) { this.bpm.value = pt.bpm; this.sig.value = `${pt.num}/${pt.den}`; this.buildBeats(); }
    if (this.audio.node) this.sendTransport();
    for (const fn of this.transportSubs) fn(t);
  }

  // The host bar: on a synth's own page, the parts a DAW would provide (start
  // the sound, MIDI input, tempo, stop all sound) that the page didn't place
  // itself. At the top of the page, or where the page mounted "hostbar";
  // sk.hostBar(false) or { midi / tempo / panic: false } leave parts out.
  buildHostBar(pageRoot) {
    const o = this.hostBarOpts || {};
    if (o === false || this.hostBarOpts === false) return;
    const parts = [];
    if (!this.host) parts.push(this.banner);
    if (!this.host && o.midi !== false && !this.midi.root.parentNode) parts.push(this.midi.root);
    if (o.tempo !== false && !this.noTempo && !this.tempoShown) parts.push(this.tempoEl());
    if (o.panic !== false && !this.panicBtn.parentNode) parts.push(this.panicBtn);
    if (o.space === false) this.spacePlays = false;
    this.banner.classList.add("in-hostbar");
    const bar = h("div", { class: "sk-hostbar" }, ...parts);
    if (this.hostBarEl) this.hostBarEl.append(bar);
    else pageRoot.prepend(bar);
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

  onTransport(fn) { this.transportSubs.add(fn); return () => this.transportSubs.delete(fn); }

  followClock(bpm, playing, beat) {
    if (this.clockSource !== "midi") return;
    const t = this.transport;
    t.bpm = bpm;
    t.playing = playing;
    this.bpm.value = bpm;
    this.play.setAttribute("aria-pressed", String(playing));
    this.play.textContent = playing ? "Stop" : "Play";
    this.audio.send({ t: "clock", bpm, playing, beat });
  }

  setClockSource(src) {
    this.clockSource = src;
    skStore.set("synthkit:clock", src);
    const midi = src === "midi";
    this.bpm.disabled = midi;
    this.play.disabled = midi;
    this.play.title = midi ? "Follows your MIDI clock's start and stop" : "Start the tempo clock (space)";
    if (midi) {
      if (!this.midi.access) this.midi.connect();
      this.toast("Following MIDI clock. Start your sequencer or DAW to play.");
    } else {
      this.transport.playing = false;
      this.play.setAttribute("aria-pressed", "false");
      this.play.textContent = "Play";
      this.sendTransport();
    }
  }

  meter(mtr) {
    if (this.host) this.followHost(mtr);
    for (const fn of this.meterTaps || []) { try { fn(mtr); } catch (err) { console.error(err); } }
    this.modMeters.update(mtr.mod, mtr.voices > 0);
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

  // The DAW's tempo and time signature, as the plugin last saw them.
  followHost(mtr) {
    const t = this.transport;
    const bpm = Math.round(mtr.bpm * 100) / 100;
    const sigChanged = mtr.num !== t.num || mtr.den !== t.den;
    t.bpm = bpm; t.playing = mtr.playing; t.num = mtr.num; t.den = mtr.den;
    const text = `${bpm} BPM · ${t.num}/${t.den}`;
    if (this.tempoReadout.textContent !== text) this.tempoReadout.textContent = text;
    if (sigChanged) { this.buildBeats(); for (const fn of this.transportSubs) fn(t); }
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
    const canMod = ctl.p.modulatable && this.model.mod.slots > 0;
    this.menu(x, y, [
      { label: `Reset to ${this.model.format(ctl.p.index, ctl.p.def)}`, run: () => ctl.reset() },
      canMod ? { label: "Modulate…", run: () => this.modulateMenu(ctl, x, y) } : null,
      // In the plugin, map controllers with the DAW's own MIDI mapping instead.
      this.host ? null : learning ? { label: "Stop MIDI learn", run: () => this.midi.cancelLearn() } : { label: "MIDI learn", run: () => this.midi.learn(ctl) },
      !this.host && cc !== null ? { label: `Forget CC ${cc}`, run: () => this.midi.forget(ctl.p.id) } : null,
    ].filter(Boolean));
  }

  modulateMenu(ctl, x, y) {
    const items = [];
    for (const [label, test] of SK_SOURCE_GROUPS) {
      const group = this.model.mod.sources.filter((s) => test(s) && skLfoInUse(this.model, s.id));
      if (!group.length) continue;
      if (items.length) items.push(null);
      for (const s of group) items.push({ label: s.name, run: () => this.addModulation(s, ctl) });
    }
    const custom = this.model.mod.sources.filter((s) => !SK_SOURCE_GROUPS.some(([, t]) => t(s)));
    if (custom.length) { items.push(null); for (const s of custom) items.push({ label: s.name, run: () => this.addModulation(s, ctl) }); }
    this.menu(x, y, items);
  }
  addModulation(src, ctl) {
    const routes = this.model.routes();
    if (routes.length >= this.model.mod.slots) { this.toast(`All ${this.model.mod.slots} modulation routes are in use. Remove one to add another.`); return; }
    routes.push({ src: src.id, dst: ctl.p.id, amt: 0.25 });
    this.model.setRoutes(routes);
    this.toast(`${src.name} now modulates ${ctl.label} by 25%. Adjust it in the Modulation panel.`);
    if (this.matrix) { skReveal(this.matrix.root); this.matrix.root.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
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

  // ---- a synth's own page (ui/page.js, API.md §9a) --------------------------

  // The object passed to the page's mount(sk, root).
  pageApi() {
    const m = this.model, app = this;
    const pr = this.presets;
    const entry = (name, kind) => pr.entries().find((e) => e.name === name && (!kind || e.kind === kind));
    const storeKey = (k) => `synthkit:${m.info.synth.id}:page:${k}`;
    return {
      info: { synth: m.info.synth, params: m.params, messages: this.messageIds.slice(), custom: m.info.custom.slice() },
      host: !!this.host,

      // parameters
      param: (id) => m.param(id),
      get: (id) => m.get(id),
      set: (id, v) => m.set(id, v, "ui"),
      setNorm: (id, n) => m.setNorm(id, n, "ui"),
      norm: (id) => m.norm(id),
      format: (id, v) => m.format(id, v),
      parse: (id, text) => m.parse(id, text),
      reset: (id) => m.reset(id),
      gesture: (id, on) => m.gesture(id, on),
      onParam: (id, fn) => { const off = m.on(id, fn); fn(m.get(id)); return off; },

      // custom state (API.md §5a)
      custom: (id) => m.custom(id),
      setCustom: (id, v) => m.setCustom(id, v),
      onCustom: (id, fn) => { const off = m.onCustom(id, fn); fn(m.custom(id)); return off; },

      // messages (API.md §9b)
      send: (id, ...values) => app.sendMessage(id, values),
      onMessage: (id, fn) => app.onMessage(id, fn),

      // meters: a mod source's live value, or the whole meter frame
      onMeter: (id, fn) => app.modMeters.onSource(id, fn),
      onMeters: (fn) => { const prev = app.meterTaps || (app.meterTaps = new Set()); prev.add(fn); return () => prev.delete(fn); },

      // playing
      noteOn: (n, v = 100) => app.noteOn(n, v),
      noteOff: (n) => app.noteOff(n),
      midi: (bytes) => app.sendMidi(bytes),
      onMidi: (fn) => { app.midiListeners.add(fn); return () => app.midiListeners.delete(fn); },
      takeMidi: (fn) => { app.midiTaps.add(fn); return () => app.midiTaps.delete(fn); },
      hostBar: (opts) => { app.hostBarOpts = opts === false ? false : { ...(app.hostBarOpts || {}), ...(opts || {}) }; },
      transport: () => ({ ...app.transport, source: app.host ? "daw" : app.clockSource === "midi" ? "midiClock" : "browser" }),
      onTransport: (fn) => app.onTransport(fn),
      connectMidi: () => app.midi.connect(),
      allNotesOff: () => app.audio.send({ t: "allOff" }),
      panic: () => app.panic(),
      start: () => app.startAudio(),
      get running() { return app.host ? true : app.audio.running; },

      // presets (the kit's preset store; mount "presets" for its bar)
      presets: {
        list: () => pr.entries().map((e) => ({ name: e.name, kind: e.kind })),
        current: () => ({ ...pr.current, dirty: !!m.dirty }),
        load: (name, kind) => { const e = entry(name, kind); return e ? pr.load(e) : false; },
        save: () => { if (pr.current.kind !== "user") return false; pr.store(pr.current.name); return true; },
        saveAs: (name) => { if (!String(name || "").trim()) return false; pr.store(String(name).trim()); return true; },
        rename: (name) => pr.renameTo(String(name || "").trim()),
        remove: () => { if (pr.current.kind !== "user") return false; pr.remove(); return true; },
        revert: () => { const e = entry(pr.current.name, pr.current.kind); return e ? pr.load(e) : false; },
        init: () => pr.init(),
        exportFile: () => pr.exportFile(),
        importFile: () => pr.startImport(),
        // A patch the page made (from an older format, say): loaded, then
        // saved as one of your presets under its own name (made unique).
        importPatch: (patch) => {
          const res = m.loadPatch({ ...patch, synth: m.info.synth.id });
          if (!res.ok) return { ok: false, error: res.error };
          const base = String(patch.name || "Imported").trim() || "Imported";
          const taken = new Set(pr.entries().map((e) => e.name));
          let name = base;
          for (let k = 2; taken.has(name); k++) name = `${base} (${k})`;
          pr.store(name);
          return { ok: true, name, warnings: res.warnings || [] };
        },
        onChange: (fn) => { pr.listeners.add(fn); return () => pr.listeners.delete(fn); },
      },

      // settings kept for this synth (the browser's storage, or the plugin's
      // shared settings file); not part of the sound
      store: {
        get: (key, fallback) => skStore.get(storeKey(key), fallback),
        set: (key, value) => skStore.set(storeKey(key), value),
      },

      toast: (msg, kind) => app.toast(msg, kind),
      menu: (x, y, items) => app.menu(x, y, items),
      mount: (el, name, opts) => app.mountPart(el, name, opts || {}),
    };
  }

  // Puts one of the kit's parts into an element of the synth's page.
  mountPart(el, name, opts) {
    let part = null;
    switch (name) {
      case "presets": part = this.presets.root; break;
      case "keyboard":
        part = this.keyboard.root;
        this.keyboard.typing = opts.typing !== false;
        {
          // The keyboard's bar takes the tempo and MIDI controls unless the
          // page placed them elsewhere (or asked for no tempo).
          const bar = [];
          if (opts.tempo === false) this.noTempo = true;   // an instrument without a clock
          if (opts.tempo !== false && !this.tempoShown) bar.push(this.tempoEl());
          if (!this.host && opts.midi !== false && !this.midi.root.parentNode) bar.push(this.midi.root);
          if (bar.length) this.keyboard.addToBar(...bar);
        }
        break;
      case "midi": part = this.host ? null : this.midi.root; break;   // the DAW routes MIDI in the plugin
      case "tempo": part = this.tempoEl(); if (opts.space === false) this.spacePlays = false; break;
      case "hostbar":
        // Filled in once mount() returns, with whatever the page didn't place.
        if (opts) this.hostBarOpts = { ...(this.hostBarOpts || {}), ...opts };
        this.hostBarEl = el;
        return el;
      case "output": part = this.outputEl; break;
      case "panic": part = this.panicBtn; break;
      case "theme": part = this.themeBtn; break;
      case "panels": {
        const p = new Panels(this);
        part = p.build(opts.sections ? opts : (this.layout.sections ? this.layout : null));
        this.reportProblems(p.problems);
        break;
      }
      case "section": {
        const p = new Panels(this);
        part = p.section(opts);
        this.reportProblems(p.problems);
        break;
      }
      case "control": {
        const p = new Panels(this);
        part = p.control(opts);
        this.reportProblems(p.problems);
        break;
      }
      default:
        this.toast(`mount: there's no part called "${name}"`, "warn");
        return null;
    }
    if (part && el) el.append(part);
    if (name === "keyboard") requestAnimationFrame(() => this.keyboard.layout());
    // Controls added after boot get their modulation rings too.
    const ringed = this.controls.filter((c) => c.modulated && !c.ringed);
    for (const c of ringed) c.ringed = true;
    if (ringed.length) this.modMeters.on((mm) => { for (const c of ringed) c.modulated(mm.active ? mm.param(c.p.index) : NaN); });
    return part;
  }

  reportProblems(list) {
    if (this.pageProblems) this.pageProblems.push(...list);
    else for (const p of list) this.toast(p.msg || p, p.kind || "warn");
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
      onMeter: (id, fn) => this.modMeters.onSource(id, fn),
      noteOn: (n, v = 100) => this.noteOn(n, v),
      noteOff: (n) => this.noteOff(n),
      send: (id, ...values) => this.sendMessage(id, values),
      onMessage: (id, fn) => this.onMessage(id, fn),
      toast: (msg, kind) => this.toast(msg, kind),
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
      evalCurve: skEvalCurve,
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
