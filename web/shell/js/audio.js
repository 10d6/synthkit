// Audio output: creates the AudioContext and the worklet running the synth.

// A data: URL rather than a blob: URL, because Chrome refuses blob: worklets
// on pages opened straight from disk (file://).
function skWorkletUrl() {
  if (!skWorkletUrl.url) {
    const src = document.getElementById("sk-worklet").textContent;
    const bytes = skUtf8Encode(src);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.slice(i, i + 0x8000));
    skWorkletUrl.url = "data:text/javascript;base64," + btoa(bin);
  }
  return skWorkletUrl.url;
}

class Audio {
  constructor(wasmBytes) {
    this.wasm = wasmBytes;
    this.ctx = null;
    this.node = null;
    this.onMeter = null;
    this.onLog = null;
    this.onMessages = null;   // ([[index, values], …]) from the synth
    this.starting = null;
  }

  get running() { return !!this.node && this.ctx.state === "running"; }

  // Must be called from a user gesture (browsers block audio until then).
  start(model, transport) {
    if (this.starting) return this.starting;
    const attempt = (async () => {
      this.ctx = new AudioContext({ latencyHint: "interactive" });
      await this.ctx.audioWorklet.addModule(skWorkletUrl());
      this.node = new AudioWorkletNode(this.ctx, "synthkit", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: {
          wasm: this.wasm.slice().buffer,
          patch: JSON.stringify(model.savePatch()),
          custom: model.customSnapshot(),
          transport,
        },
      });
      this.node.port.onmessage = (e) => {
        const m = e.data;
        if (m.t === "meter" && this.onMeter) this.onMeter(m);
        else if (m.t === "msgs" && this.onMessages) this.onMessages(m.list);
        else if (m.t === "log") { console.error("[synth]", m.msg); if (this.onLog) this.onLog(m.msg); }
      };
      this.node.onprocessorerror = () => { if (this.onLog) this.onLog("The synth stopped with an error. Reload the page to restart it."); };
      this.node.connect(this.ctx.destination);
      if (this.ctx.state !== "running") await this.ctx.resume();
    })();
    this.starting = attempt.catch((err) => {
      // Let the next click try again from scratch.
      this.starting = null;
      if (this.ctx) this.ctx.close().catch(() => {});
      this.ctx = null;
      this.node = null;
      throw err;
    });
    return this.starting;
  }

  send(msg) { if (this.node) this.node.port.postMessage(msg); }
  midi(bytes) { this.send({ t: "midi", d: bytes }); }

  // Sink interface used by Model.
  sink() {
    return {
      param: (i, v) => this.send({ t: "param", i, v }),
      patch: (json) => this.send({ t: "patch", json }),
      custom: (id, json) => this.send({ t: "custom", id, json }),
      mod: (json) => this.send({ t: "mod", json }),
      shapes: (json) => this.send({ t: "shapes", json }),
      message: (i, v) => this.send({ t: "msg", i, v }),
    };
  }

  // Render offline through the same worklet (used by tests, and handy for
  // bouncing a phrase). events: [{t: seconds, d: [status, d1, d2]}].
  static async renderOffline(wasmBytes, { patch, custom, events = [], seconds = 2, sampleRate = 48000, transport }) {
    const len = Math.ceil(seconds * sampleRate);
    const ctx = new OfflineAudioContext(2, len, sampleRate);
    await ctx.audioWorklet.addModule(skWorkletUrl());
    // events: {t, d: [MIDI bytes]} or {t, m: [message index, values]}; at the
    // same time, messages go first (as in the native render tool).
    const schedule = events.map((e) => (e.m ? { sample: Math.round(e.t * sampleRate), m: e.m } : { sample: Math.round(e.t * sampleRate), d: e.d }))
      .sort((a, b) => a.sample - b.sample || (b.m ? 1 : 0) - (a.m ? 1 : 0));
    const node = new AudioWorkletNode(ctx, "synthkit", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { wasm: wasmBytes.slice().buffer, patch, custom, schedule, transport, meters: false },
    });
    node.connect(ctx.destination);
    const buf = await ctx.startRendering();
    return { left: buf.getChannelData(0), right: buf.getChannelData(1), sampleRate };
  }
}
