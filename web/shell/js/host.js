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
    this.node = true;        // App checks this before sending MIDI
    window.__JUCE__.backend.addEventListener("sk", (m) => this.receive(m));
  }

  get running() { return true; }
  start() { return Promise.resolve(); }

  send(msg) { window.__JUCE__.backend.emitEvent("sk", msg); }
  midi(bytes) { this.send({ t: "midi", d: bytes }); }

  sink() {
    return {
      param: (i, v) => this.send({ t: "param", i, v }),
      gesture: (i, on) => this.send({ t: "gesture", i, on }),
      patch: (json) => this.send({ t: "patch", json }),
      custom: (id, json) => this.send({ t: "custom", id, json }),
      mod: (json) => this.send({ t: "mod", json }),
      shapes: (json) => this.send({ t: "shapes", json }),
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
    } else if (this.onHost) {
      this.onHost(m);
    }
  }
}
