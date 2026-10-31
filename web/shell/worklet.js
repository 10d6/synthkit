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
    // (The patch includes the mod matrix and shapes.)
    if (o.patch) this.w.withStrings([o.patch], (p) => this.x.sk_load_patch(p));
    for (const [id, json] of Object.entries(o.custom || {})) this.w.withStrings([id, json], (a, b) => this.x.sk_set_custom(a, b));
    this.block = 128;
    this.x.sk_prepare(sampleRate, this.block);
    this.meterCount = this.x.sk_mod_meter_count();
    this.clockCorr = 0;  // beats still to absorb when following MIDI clock

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
      case "mod": this.w.withStrings([m.json], (p) => x.sk_set_mod(p)); break;
      case "shapes": this.w.withStrings([m.json], (p) => x.sk_set_shapes(p)); break;
      case "clock": {
        // Follow external MIDI clock: big differences are jumps, small ones
        // are absorbed gradually so the engine never sees a false jump.
        this.bpm = m.bpm;
        if (m.playing && !this.playing) { this.beat = m.beat; this.clockCorr = 0; }
        this.playing = m.playing;
        const err = m.beat - this.beat;
        if (Math.abs(err) > 0.5) { this.beat = m.beat; this.clockCorr = 0; } else this.clockCorr = err;
        break;
      }
      case "transport":
        if (m.playing && !this.playing) this.beat = 0;  // start from the top
        this.bpm = m.bpm; this.playing = m.playing; this.num = m.num; this.den = m.den;
        break;
      case "msg": {
        const v = m.v || [];
        x.sk_message(m.i, Math.min(4, v.length), v[0] || 0, v[1] || 0, v[2] || 0, v[3] || 0);
        break;
      }
      case "allOff": x.sk_all_notes_off(); break;
      case "panic": x.sk_panic(); break;
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const n = L.length;
    const x = this.x;
    const sched = this.schedule;
    for (const d of this.queue) x.sk_midi(0, d[0], d[1] | 0, d[2] | 0);
    this.queue.length = 0;
    // Offline renders may schedule messages ({sample, m: [index, values]});
    // the block is split at each, as the native render tool does, so the two
    // agree sample for sample.
    let done = 0;
    while (done < n) {
      const at = this.pos + done;
      while (this.si < sched.length && sched[this.si].m && sched[this.si].sample <= at) {
        const [i, v = []] = sched[this.si++].m;
        x.sk_message(i, Math.min(4, v.length), v[0] || 0, v[1] || 0, v[2] || 0, v[3] || 0);
      }
      let end = n;
      for (let k = this.si; k < sched.length && sched[k].sample < this.pos + n; k++)
        if (sched[k].m) { end = Math.min(end, sched[k].sample - this.pos); break; }
      if (end <= done) end = n;   // never stall
      while (this.si < sched.length && !sched[this.si].m && sched[this.si].sample < this.pos + end) {
        const ev = sched[this.si++];
        x.sk_midi(Math.max(0, ev.sample - at), ev.d[0], ev.d[1] | 0, ev.d[2] | 0);
      }
      const len = end - done;
      x.sk_process(len, this.bpm, this.playing ? 1 : 0, this.beat, this.num, this.den);
      // Views must be re-created if the module's memory grew.
      const buf = this.x.memory.buffer;
      L.set(new Float32Array(buf, x.sk_left(), len), done);
      if (R !== L) R.set(new Float32Array(buf, x.sk_right(), len), done);
      if (this.playing) {
        this.beat += (len / sampleRate) * (this.bpm / 60);
        if (this.clockCorr !== 0) {
          const step = this.clockCorr * Math.min(1, len / (sampleRate * 0.2));
          this.beat += step;
          this.clockCorr -= step;
          if (Math.abs(this.clockCorr) < 1e-6) this.clockCorr = 0;
        }
      }
      done = end;
    }
    this.pos += n;
    const l = L, r = R;

    // Messages the synth posted for the page (API.md §9b).
    const nm = x.sk_take_messages();
    if (nm) {
      const mb = new Float32Array(this.x.memory.buffer, x.sk_message_buffer(), nm * 6);
      const list = [];
      for (let k = 0; k < nm; k++) list.push([mb[k * 6], Array.from(mb.subarray(k * 6 + 2, k * 6 + 2 + mb[k * 6 + 1]))]);
      this.port.postMessage({ t: "msgs", list });
    }

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
      const mod = new Float32Array(this.meterCount);
      if (this.meterCount) mod.set(new Float32Array(this.x.memory.buffer, x.sk_mod_meters(), this.meterCount));
      this.port.postMessage({ t: "meter", voices: st[0], limiterDb: st[1], peak: this.peak, beat: this.beat, playing: this.playing, bpm: this.bpm, scope: trace, mod }, [trace.buffer, mod.buffer]);
      this.peak = 0;
    }
    return true;
  }
}

registerProcessor("synthkit", SynthkitProcessor);
