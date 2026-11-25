#!/usr/bin/env python3
"""Random fast playing, to catch notes that never stop.

Hand-written scenarios miss the orderings that break voice handling (a release that reaches a
voice before its strike, a restrike in the same sample as a pedal change, ...). This generates
random passages of fast repeats, chords, overlapping notes and sustain- and sostenuto-pedal changes, renders each
with the synth's render tool, and reports every passage still sounding some time after all its
keys and the pedal were released. Every note-on gets its note-off.

    python3 tools/stress.py build/<synth>_render [count] [options] [param=value ...]

    count             passages to play (default 100); passage n always uses seed n
    --mode balanced   a key is released before it is struck again, as on a keyboard (default)
    --mode overlap    a key can be struck again while still down, each press with its own
                      note-off later, as from a sequencer
    --keys LO-HI      MIDI notes to play (default 21-108)
    --tail S          how long after the last release the synth must be quiet (default 3 s)
    --below DB        what counts as quiet: peak dBFS (default -80)
    --no-pedal        no sustain or sostenuto pedal (CC 64, 66)
    --patch NAME      the patch every passage starts from (default init)
    --multi FILE      play a multi (API.md §5b) instead of a patch: the zones route the keys;
                      param=value then applies to every part
    --out DIR         where failing passages are saved (default: the temp directory)
    param=value       settings for every passage, e.g. amp.release=0.5

A delay or reverb keeps sounding after the last note by design, and on a loud passage its
repeats can still be above --below when --tail is up. Turn the effect's mix to 0 for these runs
(delay.mix=0), so that anything still ringing is a voice that didn't stop.

A failing passage is saved as stuck_<seed>.json, a scenario to render and investigate:

    build/<synth>_render <dir>/stuck_<seed>.json --out stuck.wav

Exits 1 if any passage left sound ringing, 2 if a render failed. Standard library only.
"""
import argparse
import json
import math
import os
import random
import subprocess
import sys
import tempfile
import wave


def passage(seed, mode, lo, hi, pedal_on):
    """One random passage: (events, time of the last release)."""
    rnd = random.Random(seed)
    # keys struck more often than the rest, so repeats and restrikes are common
    fav = [k if lo <= k <= hi else (lo + hi) // 2 for k in (60, 60, 36, 72)]
    ev, t, down, pedal, sost = [], 0.0, {}, False, False
    for _ in range(rnd.randint(20, 80)):
        t += rnd.choice([0.0, 0.0, 0.005, 0.01, 0.03, 0.06, 0.12])
        r = rnd.random()
        if r < 0.08:
            if pedal_on and rnd.random() < 0.3:
                sost = not sost
                ev.append({"t": round(t, 4), "cc": 66, "value": 127 if sost else 0})
            elif pedal_on:
                pedal = not pedal
                ev.append({"t": round(t, 4), "cc": 64, "value": 127 if pedal else 0})
        elif r < 0.55:
            k = rnd.choice([rnd.randint(lo, hi)] + fav)
            if mode == "balanced" and down.get(k, 0) > 0:
                ev.append({"t": round(t, 4), "off": k})
                down[k] -= 1
                t += rnd.choice([0.0, 0.002, 0.01])
            ev.append({"t": round(t, 4), "on": k, "vel": rnd.randint(1, 127)})
            down[k] = down.get(k, 0) + 1
        else:
            held = [k for k, c in down.items() if c > 0]
            if held:
                k = rnd.choice(held)
                ev.append({"t": round(t, 4), "off": k})
                down[k] -= 1
    t += 0.05
    for k, c in down.items():
        ev += [{"t": round(t, 4), "off": k}] * c
    if pedal_on:
        ev.append({"t": round(t, 4), "cc": 64, "value": 0})
        ev.append({"t": round(t, 4), "cc": 66, "value": 0})
    return ev, t


def peak_after(path, start):
    """Peak |sample| (dBFS) from `start` seconds to the end of a PCM WAV."""
    with wave.open(path, "rb") as w:
        sr, ch, width = w.getframerate(), w.getnchannels(), w.getsampwidth()
        first = min(int(start * sr), w.getnframes())
        w.setpos(first)
        raw = w.readframes(w.getnframes() - first)
    full = float(1 << (8 * width - 1))
    peak = 0
    if width == 3:
        for i in range(0, len(raw) - 2, 3):
            v = raw[i] | (raw[i + 1] << 8) | (raw[i + 2] << 16)
            if v >= 1 << 23:
                v -= 1 << 24
            peak = max(peak, abs(v))
    elif width in (2, 4):
        import array
        a = array.array("h" if width == 2 else "i", raw)
        if sys.byteorder != "little":
            a.byteswap()
        peak = max((abs(v) for v in a), default=0)
    else:
        sys.exit(f"unsupported WAV sample width: {width} bytes")
    return 20 * math.log10(peak / full + 1e-12)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("render")
    p.add_argument("count", nargs="?", type=int, default=100)
    p.add_argument("--mode", choices=["balanced", "overlap"], default="balanced")
    p.add_argument("--keys", default="21-108")
    p.add_argument("--tail", type=float, default=3.0)
    p.add_argument("--below", type=float, default=-80.0)
    p.add_argument("--no-pedal", action="store_true")
    p.add_argument("--patch", default="init")
    p.add_argument("--multi", help="a multi's JSON file, played instead of --patch")
    p.add_argument("--out", default=tempfile.gettempdir())
    a, rest = p.parse_known_args()
    # positional `mode` too, as the piano's first version took it
    params = {}
    for arg in rest:
        if arg in ("balanced", "overlap"):
            a.mode = arg
        elif "=" in arg:
            k, v = arg.split("=", 1)
            params[k] = float(v)
        else:
            p.error(f"unrecognised argument: {arg}")
    lo, hi = (int(x) for x in a.keys.split("-"))
    os.makedirs(a.out, exist_ok=True)

    multi = None
    if a.multi:
        with open(a.multi) as f:
            multi = json.load(f)
    work = tempfile.mkdtemp(prefix="synthkit-stress-")
    js, wav = os.path.join(work, "s.json"), os.path.join(work, "s.wav")
    fails = 0
    for seed in range(a.count):
        ev, end = passage(seed, a.mode, lo, hi, not a.no_pedal)
        sc = {"params": params, "length": round(end + a.tail + 1.0, 3), "events": ev}
        sc["multi" if multi else "patch"] = multi or a.patch
        with open(js, "w") as f:
            json.dump(sc, f)
        r = subprocess.run([a.render, js, "--out", wav], capture_output=True, text=True)
        if r.returncode != 0:   # the same for every passage, most likely: a bad setting
            print(f"seed {seed}: the render failed\n{(r.stdout + r.stderr).strip()}")
            sys.exit(2)
        tail = peak_after(wav, end + a.tail)
        if tail > a.below:
            fails += 1
            out = os.path.join(a.out, f"stuck_{seed}.json")
            with open(out, "w") as f:
                json.dump(sc, f)
            print(f"seed {seed}: still {tail:.1f} dBFS {a.tail:g} s after everything was released "
                  f"({len(ev)} events): {out}")
    print(f"{a.mode}: {fails} of {a.count} passages left sound ringing {a.tail:g} s after release")
    if fails:
        print("If the synth has a delay or reverb, its tail may be what is ringing, not a note: run again with\n"
              "its mix at 0 (e.g. delay.mix=0). The saved passage shows which: render it with and without.")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
