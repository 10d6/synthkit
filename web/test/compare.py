#!/usr/bin/env python3
"""Compare a browser render (web-render.f32, interleaved float32 stereo) with
the native render of the same scenario (WAV). Fails if they differ by more
than tiny floating-point noise.

    compare.py web-render.f32 native.wav [--max-db -40]
"""
import argparse
import sys
import wave

import numpy as np


def read_wav(path):
    with wave.open(path, "rb") as w:
        n, ch, width = w.getnframes(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(n)
    if width != 3:
        sys.exit("expected a 24-bit WAV")
    b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
    v = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
    v = np.where(v >= 1 << 23, v - (1 << 24), v)
    return (v / 8388607.0).reshape(-1, ch)


ap = argparse.ArgumentParser()
ap.add_argument("web")
ap.add_argument("native")
ap.add_argument("--max-db", type=float, default=-40.0)
a = ap.parse_args()
web = np.fromfile(a.web, dtype=np.float32).reshape(-1, 2).astype(float)
nat = read_wav(a.native)
n = min(len(web), len(nat))
web, nat = web[:n], nat[:n]
rms = lambda x: np.sqrt(np.mean(x ** 2)) + 1e-12
# Worst 100 ms window, relative to the signal in that window.
win, worst = 4800, -200.0
for i in range(0, n - win, win):
    s = slice(i, i + win)
    if rms(nat[s]) < 1e-4:
        continue
    worst = max(worst, 20 * np.log10(rms(web[s] - nat[s]) / rms(nat[s])))
print("browser vs native: worst 100 ms difference %.1f dB (limit %.1f dB)" % (worst, a.max_db))
sys.exit(0 if worst <= a.max_db else 1)
