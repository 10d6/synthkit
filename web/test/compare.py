#!/usr/bin/env python3
"""Compare a browser render (web-render.f32, interleaved float32 stereo) with
the native render of the same scenario (24-bit WAV). Fails if they differ by
more than tiny floating-point noise. Standard library only.

    compare.py web-render.f32 native.wav [--max-db -40]
"""
import argparse
import array
import math
import sys
import wave


def read_web(path):
    a = array.array("f")
    with open(path, "rb") as f:
        a.frombytes(f.read())
    if sys.byteorder != "little":
        a.byteswap()
    return a  # interleaved L R L R …


def read_wav(path):
    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 3 or w.getnchannels() != 2:
            sys.exit("expected a 24-bit stereo WAV")
        raw = w.readframes(w.getnframes())
    out = array.array("f", bytes(4 * (len(raw) // 3)))
    for i in range(len(out)):
        b = raw[3 * i: 3 * i + 3]
        v = b[0] | (b[1] << 8) | (b[2] << 16)
        if v >= 1 << 23:
            v -= 1 << 24
        out[i] = v / 8388607.0
    return out


ap = argparse.ArgumentParser()
ap.add_argument("web")
ap.add_argument("native")
ap.add_argument("--max-db", type=float, default=-40.0)
a = ap.parse_args()
web, nat = read_web(a.web), read_wav(a.native)
n = min(len(web), len(nat))
if n == 0:
    sys.exit("nothing to compare")

# Worst 100 ms window (48 kHz stereo), relative to the signal in that window.
win = 4800 * 2
worst = -200.0
for i in range(0, n - win, win):
    sig = diff = 0.0
    for k in range(i, i + win):
        s = nat[k]
        d = web[k] - s
        sig += s * s
        diff += d * d
    if sig / win < 1e-8:  # skip near-silence
        continue
    worst = max(worst, 10 * math.log10((diff + 1e-24) / sig))
print("browser vs native: worst 100 ms difference %.1f dB (limit %.1f dB)" % (worst, a.max_db))
sys.exit(0 if worst <= a.max_db else 1)
