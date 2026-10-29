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
    for (const i of inputs) i.onmidimessage = (e) => { if (this.choice === "all" || this.choice === i.id) this.message(e.data); };
  }
  choose(id) { this.choice = id; skStore.set("synthkit:midi:input", id); }

  message(d) {
    const st = d[0];
    if (st >= 0xf0) return;  // clock, sensing, sysex: ignored for now (MIDI clock: phase 4)
    this.dot.classList.remove("is-flash");
    void this.dot.offsetWidth;
    this.dot.classList.add("is-flash");
    const type = st & 0xf0;
    if (type === 0xb0) {
      const cc = d[1], v = d[2];
      if (this.learning) { this.assign(cc, this.learning); return; }
      const id = this.map[cc];
      if (id && this.app.model.param(id)) { this.app.model.setNorm(id, v / 127, "midi"); return; }
    }
    if (type === 0x90 && d[2] > 0) this.app.keyboard.light(d[1], true);
    else if (type === 0x80 || (type === 0x90 && d[2] === 0)) this.app.keyboard.light(d[1], false);
    this.app.sendMidi([d[0], d[1] | 0, d[2] | 0], true);
  }

  learn(ctl) {
    if (!this.access) this.connect();
    if (this.learning) this.learningCtl.root.classList.remove("is-learning");
    this.learning = ctl.p.id;
    this.learningCtl = ctl;
    ctl.root.classList.add("is-learning");
    this.app.toast(`Move a knob or slider on your MIDI controller to control ${ctl.label}. Press Esc to cancel.`);
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
