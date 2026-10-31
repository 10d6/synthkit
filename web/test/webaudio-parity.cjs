#!/usr/bin/env node
// Checks the sk::wa blocks against the browser's own Web Audio nodes.
//
//   node web/test/webaudio-parity.cjs tests/webaudio/parity.json <native-dir> [out-dir]
//
// Renders every case in the scenario file with Chromium's real nodes (in an
// OfflineAudioContext), reads the same case rendered natively by
// synthkit_wa_parity from <native-dir>/<case>.f32, and fails if any case
// differs by more than its limit (dB below the browser's output level).
// Needs Playwright (npm install playwright; npx playwright install chromium).
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

// Runs in the page: build each case's graph with real nodes and render it.
async function renderAll(cases) {
  const lcg = (seed) => {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return Math.fround((s / 4294967296) * 2 - 1); };
  };
  const automate = (param, list) => {
    for (const [op, ...args] of list || []) {
      if (op === "setValueCurveAtTime") param.setValueCurveAtTime(Float32Array.from(args[0]), args[1], args[2]);
      else param[op](...args);
    }
  };
  const makeIr = (ctx, j, sr) => {
    const ch = j.channels || 2, len = Math.floor(sr * (j.seconds || 0.2)), decay = j.decay ?? 3;
    const buf = ctx.createBuffer(ch, len, sr), rng = lcg(j.seed || 1);
    for (let c = 0; c < ch; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = rng() * Math.pow(1 - i / len, decay);
    }
    return buf;
  };
  const softclip = (n) => {
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i * 2) / (n - 1) - 1; c[i] = Math.tanh(2.5 * x) / Math.tanh(2.5); }
    return c;
  };
  const out = {};
  for (const c of cases) {
    const sr = c.sampleRate || 48000, len = Math.round(sr * (c.length || 0.5));
    const ctx = new OfflineAudioContext(2, len, sr);
    const s = c.source;
    let node;
    if (s.type === "noise" || s.type === "impulse") {
      const stereo = !!s.stereo;
      const buf = ctx.createBuffer(stereo ? 2 : 1, len, sr);
      if (s.type === "impulse") buf.getChannelData(0)[0] = 1;
      else {
        const gain = s.gain ?? 0.5;
        const rl = lcg(s.seed || 1), rr = lcg(((s.seed || 1) + 7777) >>> 0);
        const L = buf.getChannelData(0), R = stereo ? buf.getChannelData(1) : null;
        for (let i = 0; i < len; i++) {
          const t = i / sr, env = s.envelope ? (t % 0.25 < 0.12 ? 1 : 0.08) : 1;
          L[i] = rl() * gain * env;
          if (R) R[i] = rr() * gain * env;
        }
      }
      node = new AudioBufferSourceNode(ctx, { buffer: buf });
      node.start(0);
    } else if (s.type === "osc") {
      const osc = new OscillatorNode(ctx);
      if (s.basic) osc.type = s.basic;
      else {
        const n = Math.max(s.wave.real.length, s.wave.imag.length);
        const re = new Float32Array(n), im = new Float32Array(n);
        re.set(s.wave.real); im.set(s.wave.imag);
        osc.setPeriodicWave(ctx.createPeriodicWave(re, im, { disableNormalization: !!s.wave.disableNormalization }));
      }
      osc.frequency.value = s.frequency ?? 440;
      automate(osc.frequency, s.frequencyAuto);
      osc.detune.value = s.detune ?? 0;
      automate(osc.detune, s.detuneAuto);
      osc.start(0);
      node = osc;
      if ((s.gain ?? 1) !== 1) node = node.connect(new GainNode(ctx, { gain: s.gain }));
    } else if (s.type === "constant") {
      const k = new ConstantSourceNode(ctx, { offset: s.offset ?? 1 });
      automate(k.offset, s.auto);
      k.start(0);
      node = k;
    }
    for (const n of c.chain || []) {
      let next;
      if (n.node === "biquad") next = new BiquadFilterNode(ctx, { type: n.type || "lowpass", frequency: n.frequency ?? 350, Q: n.Q ?? 1, gain: n.gain ?? 0, detune: n.detune ?? 0 });
      else if (n.node === "compressor") next = new DynamicsCompressorNode(ctx, { threshold: n.threshold ?? -24, knee: n.knee ?? 30, ratio: n.ratio ?? 12, attack: n.attack ?? 0.003, release: n.release ?? 0.25 });
      else if (n.node === "convolver") { next = new ConvolverNode(ctx, { disableNormalization: n.normalize === false }); next.buffer = makeIr(ctx, n.ir, sr); }
      else if (n.node === "shaper") next = new WaveShaperNode(ctx, { curve: softclip(n.curve.softclip || 1025), oversample: n.oversample || "none" });
      else if (n.node === "panner") next = new StereoPannerNode(ctx, { pan: n.pan ?? 0 });
      else if (n.node === "delay") { next = new DelayNode(ctx, { maxDelayTime: 1, delayTime: n.time ?? 0 }); automate(next.delayTime, n.timeAuto); }
      node = node.connect(next);
    }
    node.connect(ctx.destination);
    const r = await ctx.startRendering();
    const L = r.getChannelData(0), R = r.getChannelData(1), inter = new Float32Array(len * 2);
    for (let i = 0; i < len; i++) { inter[2 * i] = L[i]; inter[2 * i + 1] = R[i]; }
    let bin = "";
    const bytes = new Uint8Array(inter.buffer);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    out[c.name] = btoa(bin);
  }
  return out;
}

function compare(ref, got) {
  const n = Math.min(ref.length, got.length);
  let e = 0, p = 0, worst = 0, at = 0;
  for (let i = 0; i < n; i++) {
    const d = got[i] - ref[i];
    e += d * d;
    p += ref[i] * ref[i];
    if (Math.abs(d) > worst) { worst = Math.abs(d); at = i >> 1; }
  }
  const db = p > 0 ? 10 * Math.log10(e / p + 1e-30) : (e > 0 ? 0 : -200);
  return { db, worst, at, lengthOk: ref.length === got.length, refRms: Math.sqrt(p / Math.max(1, n)) };
}

(async () => {
  const [scenarioPath, nativeDir, outDir] = process.argv.slice(2);
  if (!scenarioPath || !nativeDir) { console.error("usage: webaudio-parity.cjs scenarios.json native-dir [out-dir]"); process.exit(2); }
  const { cases } = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto("about:blank");
  const rendered = await page.evaluate(renderAll, cases);
  await browser.close();

  let failed = 0;
  const report = [];
  for (const c of cases) {
    const ref = new Float32Array(Buffer.from(rendered[c.name], "base64").buffer.slice(0));
    const file = path.join(nativeDir, c.name + ".f32");
    if (!fs.existsSync(file)) { console.log(`  FAIL  ${c.name}: no native render (${file})`); failed++; continue; }
    const b = fs.readFileSync(file);
    const got = new Float32Array(b.buffer, b.byteOffset, b.length / 4);
    const r = compare(ref, got);
    const limit = c.limit ?? -80;
    const ok = r.lengthOk && r.db <= limit && r.refRms > 1e-6;
    if (!ok) failed++;
    report.push({ name: c.name, db: r.db, limit, worst: r.worst, at: r.at });
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${c.name.padEnd(28)} ${r.db.toFixed(1).padStart(7)} dB (limit ${limit}), worst sample ${r.worst.toExponential(2)} at frame ${r.at}${r.refRms <= 1e-6 ? " [browser output silent]" : ""}`);
    if (outDir) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, c.name + ".browser.f32"), Buffer.from(ref.buffer));
    }
  }
  if (outDir) fs.writeFileSync(path.join(outDir, "parity.json"), JSON.stringify(report, null, 2));
  console.log(failed ? `FAILED: ${failed} case(s)` : `OK: ${cases.length} cases match the browser`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
