// AudioWorklet processor: runs the synth. Receives MIDI, parameter changes and
// patches from the page; sends back meters and a scope trace.
const SCOPE = 1024;

class SynthkitProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.log = (m) => this.port.postMessage({ t: "log", msg: m });
    let memory = null;
    const mod = new WebAssembly.Module(o.wasm);
    const inst = new WebAssembly.Instance(mod, skImports(() => memory, this.log));
    memory = inst.exports.memory;
    this.w = new SkWasm(inst);
    this.x = this.w.x;
    // Load the sound before prepare, so parameters start at their values
    // instead of gliding there from the defaults.
    if (o.patch) this.w.withStrings([o.patch], (p) => this.x.sk_load_patch(p));
    for (const [id, json] of Object.entries(o.custom || {})) this.w.withStrings([id, json], (a, b) => this.x.sk_set_custom(a, b));
    this.block = 128;
    this.x.sk_prepare(sampleRate, this.block);

    const tr = o.transport || {};
    this.bpm = tr.bpm || 120;
    this.playing = !!tr.playing;
    this.num = tr.num || 4;
    this.den = tr.den || 4;
    this.beat = 0;

    this.queue = [];                   // live MIDI: [status, d1, d2]
    this.schedule = o.schedule || [];  // offline renders: {sample, d}
    this.si = 0;
    this.pos = 0;
    this.scope = new Float32Array(SCOPE);
    this.scopePos = 0;
    this.peak = 0;
    this.meterEvery = Math.round(sampleRate / 30);
    this.sinceMeter = 0;
    this.meters = o.meters !== false;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    const x = this.x;
    switch (m.t) {
      case "midi": this.queue.push(m.d); break;
      case "param": x.sk_set_param(m.i, m.v); break;
      case "patch": this.w.withStrings([m.json], (p) => x.sk_load_patch(p)); break;
      case "custom": this.w.withStrings([m.id, m.json], (a, b) => x.sk_set_custom(a, b)); break;
      case "transport":
        if (m.playing && !this.playing) this.beat = 0;  // start from the top
        this.bpm = m.bpm; this.playing = m.playing; this.num = m.num; this.den = m.den;
        break;
      case "allOff": x.sk_all_notes_off(); break;
      case "panic": x.sk_panic(); break;
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const n = L.length;
    const x = this.x;
    for (const d of this.queue) x.sk_midi(0, d[0], d[1] | 0, d[2] | 0);
    this.queue.length = 0;
    while (this.si < this.schedule.length && this.schedule[this.si].sample < this.pos + n) {
      const ev = this.schedule[this.si++];
      x.sk_midi(Math.max(0, ev.sample - this.pos), ev.d[0], ev.d[1] | 0, ev.d[2] | 0);
    }
    x.sk_process(n, this.bpm, this.playing ? 1 : 0, this.beat, this.num, this.den);
    if (this.playing) this.beat += (n / sampleRate) * (this.bpm / 60);
    this.pos += n;
    // Views must be re-created if the module's memory grew.
    const buf = this.x.memory.buffer;
    const l = new Float32Array(buf, x.sk_left(), n), r = new Float32Array(buf, x.sk_right(), n);
    L.set(l);
    if (R !== L) R.set(r);

    if (!this.meters) return true;
    for (let i = 0; i < n; i++) {
      const v = 0.5 * (l[i] + r[i]);
      this.scope[this.scopePos] = v;
      this.scopePos = (this.scopePos + 1) % SCOPE;
      const a = Math.max(Math.abs(l[i]), Math.abs(r[i]));
      if (a > this.peak) this.peak = a;
    }
    this.sinceMeter += n;
    if (this.sinceMeter >= this.meterEvery) {
      this.sinceMeter = 0;
      const st = new Float32Array(this.x.memory.buffer, x.sk_stats(), 5);
      const trace = new Float32Array(SCOPE);
      for (let i = 0; i < SCOPE; i++) trace[i] = this.scope[(this.scopePos + i) % SCOPE];
      this.port.postMessage({ t: "meter", voices: st[0], limiterDb: st[1], peak: this.peak, beat: this.beat, playing: this.playing, scope: trace }, [trace.buffer]);
      this.peak = 0;
    }
    return true;
  }
}

registerProcessor("synthkit", SynthkitProcessor);
