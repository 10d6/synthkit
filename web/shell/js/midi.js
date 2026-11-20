// Web MIDI input and MIDI learn. Learned CCs move their control and are not
// passed on to the synth (so CC 1 learned to cutoff stops being mod wheel).

class MidiInput {
  constructor(app) {
    this.app = app;
    this.key = `synthkit:${app.model.info.synth.id}:midiLearn`;
    this.map = skStore.get(this.key, {});       // cc -> param id
    this.learning = null;
    this.access = null;
    this.choice = skStore.get("synthkit:midi:input", "all");
    this.build();
  }

  build() {
    this.btn = h("button", { type: "button", class: "btn btn-quiet", onclick: () => this.connect() }, "Connect MIDI");
    this.select = h("select", { class: "midi-select", "aria-label": "MIDI input", hidden: true, onchange: () => this.choose(this.select.value) });
    this.dot = h("span", { class: "midi-dot", "aria-hidden": "true" });
    this.root = h("div", { class: "midi" }, this.dot, this.btn, this.select);
    if (skHost) return;   // the plugin gets MIDI from the DAW
    if (!navigator.requestMIDIAccess) {
      this.btn.disabled = true;
      this.btn.textContent = "No MIDI in this browser";
      this.btn.title = "Web MIDI works in Chrome, Edge, Firefox and Opera.";
    } else if (skStore.get("synthkit:midi:auto", false)) {
      this.connect();
    }
  }

  async connect() {
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (err) {
      this.app.toast("MIDI access was blocked. Allow MIDI for this page in the browser's site settings, then try again.", "error");
      return;
    }
    skStore.set("synthkit:midi:auto", true);
    this.access.onstatechange = () => this.refresh();
    this.btn.hidden = true;
    this.select.hidden = false;
    this.refresh();
  }

  refresh() {
    const inputs = [...this.access.inputs.values()];
    this.select.textContent = "";
    this.select.append(h("option", { value: "all", text: inputs.length ? "All MIDI inputs" : "No MIDI devices found" }));
    for (const i of inputs) this.select.append(h("option", { value: i.id, text: i.name || i.id }));
    if (![...this.select.options].some((o) => o.value === this.choice)) this.choice = "all";
    this.select.value = this.choice;
    for (const i of inputs) i.onmidimessage = (e) => { if (this.choice === "all" || this.choice === i.id) this.message(e.data, e.timeStamp); };
  }
  choose(id) { this.choice = id; skStore.set("synthkit:midi:input", id); }

  message(d, time) {
    const st = d[0];
    if (st >= 0xf0) {
      // Clock and transport messages, when following MIDI clock.
      if (this.app.clockSource === "midi" && (st === 0xf8 || st === 0xfa || st === 0xfb || st === 0xfc || st === 0xf2)) this.app.clock.message(d, time || performance.now());
      return;
    }
    this.dot.classList.remove("is-flash");
    void this.dot.offsetWidth;
    this.dot.classList.add("is-flash");
    if (this.app.tapMidi(d)) return;   // a synth's own page took it
    const type = st & 0xf0;
    if (type === 0xb0 && this.takeCC(d[1], d[2])) return;
    const ch = st & 0x0f;
    if (type === 0x90 && d[2] > 0) this.app.keyboard.midiNote(ch, d[1], true, d[2]);
    else if (type === 0x80 || (type === 0x90 && d[2] === 0)) this.app.keyboard.midiNote(ch, d[1], false);
    else if (type === 0xb0 && (d[1] === 123 || d[1] === 120)) this.app.keyboard.midiAllOff(ch);   // all notes / sound off
    const bytes = [d[0], d[1] | 0, d[2] | 0];
    this.app.sendMidi(bytes, true);
    this.app.keyboard.sync(bytes);   // the on-screen wheels, pedals and knobs follow
  }

  // A controller move, from a MIDI controller or from the page's own wheels,
  // pedals and knobs: a Learn waiting for a CC takes it, a CC learned to a
  // control moves that control, and neither reaches the synth. True if it
  // was taken.
  takeCC(cc, v) {
    if (this.ccLearn) { const fn = this.ccLearn; this.ccLearn = null; fn(cc); return true; }
    if (this.learning) { this.assign(cc, this.learning); return true; }
    const id = this.map[cc];
    if (id && this.app.model.param(id)) { this.app.model.setNorm(id, v / 127, "midi"); return true; }
    return false;
  }

  learn(ctl) {
    if (!this.access) this.connect();
    if (this.learning) this.learningCtl.root.classList.remove("is-learning");
    this.learning = ctl.p.id;
    this.learningCtl = ctl;
    ctl.root.classList.add("is-learning");
    this.app.toast(`Move a knob or slider on your MIDI controller, or a knob or the mod wheel on the keyboard, to control ${ctl.label}. Press Esc to cancel.`);
  }
  // The next CC that arrives goes to fn (the source picker's Learn), not
  // the synth. null stops waiting.
  learnCC(fn) {
    this.ccLearn = fn;
    if (fn && !this.access) this.connect();
  }
  cancelLearn() {
    if (!this.learning) return;
    this.learningCtl.root.classList.remove("is-learning");
    this.learning = null;
  }
  assign(cc, id) {
    for (const [k, v] of Object.entries(this.map)) if (v === id) delete this.map[k];
    this.map[cc] = id;
    skStore.set(this.key, this.map);
    const ctl = this.learningCtl;
    this.cancelLearn();
    this.app.refreshLearned();
    this.app.toast(`${ctl.label} now follows CC ${cc}`);
  }
  forget(id) {
    for (const [k, v] of Object.entries(this.map)) if (v === id) delete this.map[k];
    skStore.set(this.key, this.map);
    this.app.refreshLearned();
  }
  ccFor(id) {
    for (const [k, v] of Object.entries(this.map)) if (v === id) return Number(k);
    return null;
  }
}
