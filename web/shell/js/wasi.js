// Shared by the page and the AudioWorklet: a minimal WASI shim and helpers
// for passing strings to and from the synth's WebAssembly module.
// (TextEncoder/TextDecoder aren't available inside AudioWorklets.)

function skUtf8Encode(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.codePointAt(i);
    if (c > 0xffff) i++;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

function skUtf8Decode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++];
    let c;
    if (b < 0x80) c = b;
    else if (b < 0xe0) c = ((b & 31) << 6) | (bytes[i++] & 63);
    else if (b < 0xf0) c = ((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    else c = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    s += String.fromCodePoint(c);
  }
  return s;
}

function skBase64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Imports for the module. `log` receives text the synth prints (errors).
function skImports(getMemory, log) {
  const ENOSYS = 52, EBADF = 8;
  const view = () => new DataView(getMemory().buffer);
  const bytes = (ptr, len) => new Uint8Array(getMemory().buffer, ptr, len);
  const wasi = {
    fd_write(fd, iovs, iovsLen, nwritten) {
      const dv = view();
      let total = 0, text = "";
      for (let i = 0; i < iovsLen; i++) {
        const p = dv.getUint32(iovs + i * 8, true), n = dv.getUint32(iovs + i * 8 + 4, true);
        text += skUtf8Decode(bytes(p, n));
        total += n;
      }
      dv.setUint32(nwritten, total, true);
      if (text.trim()) log(text.trim());
      return 0;
    },
    proc_exit(code) { throw new Error("synth stopped (exit " + code + ")"); },
    environ_sizes_get(c, s) { const dv = view(); dv.setUint32(c, 0, true); dv.setUint32(s, 0, true); return 0; },
    environ_get() { return 0; },
    args_sizes_get(c, s) { const dv = view(); dv.setUint32(c, 0, true); dv.setUint32(s, 0, true); return 0; },
    args_get() { return 0; },
    clock_time_get(id, precision, out) { view().setBigUint64(out, BigInt(Date.now()) * 1000000n, true); return 0; },
    random_get(buf, len) { const b = bytes(buf, len); for (let i = 0; i < len; i++) b[i] = (Math.random() * 256) | 0; return 0; },
    fd_prestat_get() { return EBADF; },
    fd_close() { return EBADF; },
    fd_fdstat_get() { return EBADF; },
    fd_seek() { return EBADF; },
    fd_read() { return EBADF; },
  };
  return {
    wasi_snapshot_preview1: new Proxy(wasi, { get: (t, k) => t[k] || (() => ENOSYS) }),
    env: {
      sk_log(ptr, len) { log(skUtf8Decode(bytes(ptr, len))); },
    },
  };
}

// Thin wrapper over an instantiated synth module.
class SkWasm {
  constructor(instance) {
    this.x = instance.exports;
    if (this.x._initialize) this.x._initialize();
    this.x.sk_init();
  }
  get memory() { return this.x.memory; }
  // Read a NUL-terminated UTF-8 string.
  str(ptr) {
    const m = new Uint8Array(this.x.memory.buffer);
    let end = ptr;
    while (m[end] !== 0) end++;
    return skUtf8Decode(m.subarray(ptr, end));
  }
  // Call fn with pointers to NUL-terminated copies of each string argument.
  withStrings(strings, fn) {
    const ptrs = strings.map((s) => {
      const enc = skUtf8Encode(String(s));
      const p = this.x.sk_alloc(enc.length + 1);
      const m = new Uint8Array(this.x.memory.buffer);
      m.set(enc, p);
      m[p + enc.length] = 0;
      return p;
    });
    try { return fn(...ptrs); } finally { ptrs.forEach((p) => this.x.sk_free(p)); }
  }
  json(ptr) { return JSON.parse(this.str(ptr)); }
}
