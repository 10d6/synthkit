// Running inside the plugin. The plugin serves this page with its current
// state in window.__skHost and talks to it through JUCE's web view bridge
// (window.__JUCE__.backend). HostAudio stands in for Audio: the sound comes
// from the plugin, so there is nothing to start, and changes go to the plugin
// instead of an AudioWorklet.

const skHost = (typeof window !== "undefined" && window.__skHost && window.__JUCE__ && window.__JUCE__.backend) ? window.__skHost : null;

class HostAudio {
  constructor() {
    this.onMeter = null;
    this.onLog = null;
    this.onHost = null;      // (message) for params / state / store / imported
    this.onMessages = null;  // ([[index, values], …]) from the synth
    this.node = true;        // App checks this before sending MIDI
    window.__JUCE__.backend.addEventListener("sk", (m) => this.receive(m));
  }

  get running() { return true; }
  start() { return Promise.resolve(); }

  send(msg) { window.__JUCE__.backend.emitEvent("sk", msg); }
  midi(bytes) { this.send({ t: "midi", d: bytes }); }

  // Diagnostics (API.md §10a), as Audio.diagnostics(): the plugin answers
  // with the engine's report and the host it runs in.
  diagnostics() {
    this.diagWait = this.diagWait || new Map();
    const id = (this.diagId = (this.diagId || 0) + 1);
    return new Promise((resolve) => {
      this.diagWait.set(id, resolve);
      this.send({ t: "diag", id });
      setTimeout(() => { if (this.diagWait.delete(id)) resolve(null); }, 1000);
    });
  }
  // The plugin puts text on the system clipboard (a plugin window's page may
  // not be allowed to).
  copyText(text) { this.send({ t: "clipboard", text }); return Promise.resolve(true); }

  sink(part = () => 0) {
    return {
      param: (i, v) => this.send({ t: "param", i, v, p: part() }),
      gesture: (i, on) => this.send({ t: "gesture", i, on, p: part() }),
      patch: (json) => this.send({ t: "patch", json, p: part() }),
      custom: (id, json) => this.send({ t: "custom", id, json, p: part() }),
      mod: (json) => this.send({ t: "mod", json, p: part() }),
      shapes: (json) => this.send({ t: "shapes", json, p: part() }),
      message: (i, v) => this.send({ t: "msg", i, v, p: part() }),
      select: (p) => this.send({ t: "select", p }),
      layout: (json) => this.send({ t: "layout", json }),
      multi: (json) => this.send({ t: "multi", json }),
    };
  }

  receive(m) {
    if (!m) return;
    if (m.t === "meter") {
      // JSON has no NaN: the plugin sends null for "not modulated".
      m.mod = Float32Array.from(m.mod || [], (v) => (v === null ? NaN : v));
      if (this.onMeter) this.onMeter(m);
    } else if (m.t === "log") {
      if (this.onLog) this.onLog(m.msg, m.kind);
    } else if (m.t === "msgs") {
      if (this.onMessages) this.onMessages(m.list || []);
    } else if (m.t === "diag") {
      const resolve = this.diagWait && this.diagWait.get(m.id);
      if (resolve) { this.diagWait.delete(m.id); try { resolve(JSON.parse(m.json)); } catch (e) { resolve(null); } }
    } else if (this.onHost) {
      this.onHost(m);
    }
  }
}
