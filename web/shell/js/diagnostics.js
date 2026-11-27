// Diagnostics (API.md §10a): what to send when something goes wrong while
// playing (a stuck note, a note that didn't sound). The page keeps the last
// MIDI it was given; the engine keeps the last events it was given and what it
// made of them (Engine::diagnostics). A report puts both together, with where
// the synth runs, for the owner to copy to whoever is fixing it.
//
// Off by default. With it on (the menu beside Stop all sound, remembered),
// Stop all sound also makes a report: pressing it means something just went
// wrong, so that's the moment to capture. "Make a report" in the same menu
// works either way. The logs are always kept: a few entries per key press,
// so a report taken after the fact still has what led up to it.

class Diagnostics {
  constructor(app) {
    this.app = app;
    this.size = 1000;           // page MIDI entries kept
    this.ring = [];
    this.next = 0;
    this.key = "synthkit:diagnostics";
    this.on = !!skStore.get(this.key, false);
    this.pop = null;
  }

  // A MIDI message the page got (from = an input's name, "screen keys" for the
  // on-screen and computer keyboard, "page controls" for wheels, pedals and
  // knobs) and whether it went on to the synth.
  midi(from, bytes, used = true, time = performance.now()) {
    const e = [time, from, bytes[0] | 0, bytes[1] | 0, bytes[2] | 0, used ? 1 : 0];
    if (this.ring.length < this.size) this.ring.push(e);
    else this.ring[this.next] = e;
    this.next = (this.next + 1) % this.size;
  }

  setOn(on) {
    this.on = on;
    skStore.set(this.key, on);
    this.app.toast(on ? "Diagnostics on: Stop all sound now also makes a report to copy" : "Diagnostics off");
  }

  // The menu beside Stop all sound.
  menu(anchor) {
    const r = anchor.getBoundingClientRect();
    this.app.menu(r.left, r.bottom + 4, [
      { label: this.on ? "✓ Diagnostics on (Stop all sound makes a report)" : "Diagnostics off", run: () => this.setOn(!this.on) },
      { label: "Make a diagnostics report", run: () => this.show("menu") },
    ]);
  }

  // Stop all sound was pressed.
  panicked() { if (this.on) this.show("Stop all sound"); }

  async report(trigger) {
    const now = performance.now();
    const app = this.app;
    const ago = (t) => Math.round((t - now) / 10) / 100;   // seconds before the report, 0.01 s
    const hex = (b) => b.toString(16).padStart(2, "0");
    const ordered = this.ring.length < this.size ? this.ring : this.ring.slice(this.next).concat(this.ring.slice(0, this.next));
    const engine = await app.audio.diagnostics?.() ?? null;
    const info = app.model.info.synth;
    const inputs = app.midi && app.midi.access ? [...app.midi.access.inputs.values()].map((i) => i.name || i.id) : [];
    const lit = app.keyboard.litNotes ? app.keyboard.litNotes() : [];
    const r = {
      report: "synthkit diagnostics",
      trigger,
      time: new Date().toISOString(),
      synth: { id: info.id, name: info.name, version: info.version || "" },
      where: skHost ? "plugin" : "browser",
      browser: navigator.userAgent,
      midiInputs: inputs,
      midiInputChosen: app.midi ? app.midi.choice : null,
      voicesShown: app.lastVoices ?? null,
      keysLit: lit,
      // [seconds before the report, from, "status data1 data2" in hex, 1 = sent to the synth]
      pageMidi: ordered.map((e) => [ago(e[0]), e[1], `${hex(e[2])} ${hex(e[3])} ${hex(e[4])}`, e[5]]),
      // Per part: counts, then [seconds before, kind, channel 1-16, note or cc, value]
      engine: engine ? this.compact(engine) : "no answer (the sound hasn't started)",
    };
    return Diagnostics.format(r);
  }

  compact(d) {
    const out = Object.assign({}, d);
    const ev = (list) => (list || []).map((e) => [e.t, e.kind, e.ch, e.note ?? e.cc ?? null, e.value ?? null]);
    if (d.router) out.router = Object.assign({}, d.router, { events: ev(d.router.events) });
    out.parts = (d.parts || []).map((p) => Object.assign({}, p, { events: ev(p.events) }));
    return out;
  }

  // JSON with each event on one line, so a long report stays readable.
  static format(obj) {
    return JSON.stringify(obj, null, 1).replace(/\[\s*\n\s*([^\[\]{}]*?)\s*\n\s*\]/g, (m, inner) => "[" + inner.replace(/\s*\n\s*/g, " ") + "]");
  }

  async copy(text) {
    if (this.app.audio.copyText) return this.app.audio.copyText(text);   // the plugin's clipboard
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { return false; }
  }

  // The report in a box: copied if the clipboard allows, selectable if not.
  async show(trigger) {
    const text = await this.report(trigger);
    this.close();
    const area = h("textarea", { class: "diag-text", readonly: true, spellcheck: false, "aria-label": "Diagnostics report" });
    area.value = text;
    const status = h("p", { class: "diag-status", text: "Copying…" });
    const copyBtn = h("button", { type: "button", class: "btn", onclick: async () => { status.textContent = (await this.copy(text)) ? "Copied." : "Select the text and copy it (Ctrl+C / Cmd+C)."; } }, "Copy");
    const closeBtn = h("button", { type: "button", class: "btn btn-quiet", onclick: () => this.close() }, "Close");
    const buttons = [copyBtn];
    if (!skHost) {
      buttons.push(h("button", { type: "button", class: "btn btn-quiet", onclick: () => {
        const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "application/json" })), download: `${this.app.model.info.synth.id}-diagnostics.json` });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      } }, "Download"));
    }
    buttons.push(closeBtn);
    this.pop = h("div", { class: "diag-pop", role: "dialog", "aria-label": "Diagnostics report" },
      h("h2", { class: "diag-title", text: "Diagnostics report" }),
      h("p", { class: "diag-help", text: "What the synth was given and did just now. Send it to whoever is fixing the problem, with a word on what you heard." }),
      area, status, h("div", { class: "diag-buttons" }, ...buttons));
    this.pop.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") this.close(); });
    document.body.append(this.pop);
    area.focus();
    area.select();
    status.textContent = (await this.copy(text)) ? "Copied to the clipboard." : "Select the text and copy it (Ctrl+C / Cmd+C).";
  }

  close() {
    if (this.pop) this.pop.remove();
    this.pop = null;
  }
}
