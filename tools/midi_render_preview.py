#!/usr/bin/env python3
"""Offline preview renderer for the little-swans soundtrack.

Renders the exact note list from tools/midi_build.py with a simplified mirror of
the Web Audio instrument models (celesta / music box lead, plucked accompaniment,
bass, pad, bell, a little reverb + delay) to assets/audio/preview.wav.

Purpose: verify melody / arrangement / total length without a browser.
The web app does NOT load this file — it synthesizes everything live in
src/music.js.  Output: 32 kHz mono 16-bit WAV (~117 s), np required.

Usage:
    python3 tools/midi_render_preview.py [--sr 32000] [--out assets/audio/preview.wav]
"""

import argparse
import os
import sys
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from midi_build import build, fmt_num  # noqa: E402

INST_GAIN = {"lead": 0.170, "harm": 0.100, "pluck": 0.120, "bass": 0.200, "pad": 0.090, "bell": 0.100}


def midi_to_freq(p):
    return 440.0 * (2.0 ** ((p - 69) / 12.0))


def _env_ad(t, attack, decay, sr):
    """fast attack, exponential decay -> float array"""
    a = np.clip(t / max(attack, 1e-4), 0.0, 1.0)
    return a * np.exp(-t / max(decay, 1e-4))


def render_note(n, sr):
    """Return (start_sample, float32 mono buffer) for one note dict."""
    inst = n["inst"]
    f = midi_to_freq(n["midi"])
    vel = n["vel"]
    g = INST_GAIN.get(inst, 0.1) * vel
    dur = n["dur"]

    if inst in ("lead", "harm", "bell"):
        if inst == "bell":
            partials = [(1.0, 1.0), (2.0, 0.5), (3.01, 0.22), (5.4, 0.08)]
            decay = np.clip(dur * 2.2, 1.2, 4.5) / 3.2
            att = 0.004
        else:
            partials = [(1.0, 1.0), (2.0, 0.30), (3.0, 0.12), (4.16, 0.035)]
            decay = np.clip(dur * 1.7, 0.55, 3.2) / 3.2
            att = 0.003
        length = min(dur + 3.0, 8.0)
        L = int(length * sr)
        t = np.arange(L, dtype=np.float32) / sr
        env = _env_ad(t, att, decay, sr).astype(np.float32)
        wave_ = np.zeros(L, dtype=np.float32)
        vib = 1.0 + 0.0006 * np.sin(2 * np.pi * 5.1 * t) if dur > 0.45 else 1.0
        for mult, amp in partials:
            wave_ += amp * np.sin(2 * np.pi * f * mult * t * vib + np.random.rand() * 6.28)
        wave_ *= env * g
    elif inst == "pluck":
        L = int(min(dur + 0.4, 0.6) * sr)
        t = np.arange(L, dtype=np.float32) / sr
        env = _env_ad(t, 0.002, 0.055, sr).astype(np.float32)
        tone = np.sin(2 * np.pi * f * t)
        noise = np.random.randn(L).astype(np.float32)
        # crude band-pass-ish noise transient: difference of adjacent samples
        noise = np.diff(noise, prepend=0.0) * 0.35
        wave_ = (tone + noise) * env * g
    elif inst == "bass":
        L = int(min(dur + 2.2, 3.0) * sr)
        t = np.arange(L, dtype=np.float32) / sr
        decay = np.clip(dur * 1.5, 0.35, 2.2) / 3.2
        env = _env_ad(t, 0.006, decay, sr).astype(np.float32)
        wave_ = (np.sin(2 * np.pi * f * t) + 0.28 * np.sin(2 * np.pi * 2 * f * t)) * env * g
    else:  # pad
        L = int(min(dur + 1.8, 18.0) * sr)
        t = np.arange(L, dtype=np.float32) / sr
        att = np.clip(t / 0.5, 0, 1)
        rel = np.clip((dur + 1.5 - t) / 1.5, 0, 1)
        env = (np.minimum(att, rel) ** 1.5).astype(np.float32)
        wave_ = (np.sin(2 * np.pi * f * t) + 0.18 * np.sin(2 * np.pi * 2 * f * t)) * env * g

    start = int(round(n["t"] * sr))
    return start, wave_.astype(np.float32)


def simple_reverb(x, sr):
    """Cheap feedback-delay-network-ish reverb: lowpassed decaying delays."""
    # one-pole lowpass via convolution with small exponential kernel
    k = np.exp(-np.arange(int(0.004 * sr) + 1) / (0.0012 * sr)).astype(np.float32)
    k /= k.sum()
    low = np.convolve(x, k, mode="same").astype(np.float32)
    wet = np.zeros_like(x)
    taps = [(0.031, 0.55), (0.067, 0.42), (0.113, 0.32), (0.171, 0.22), (0.239, 0.15), (0.317, 0.10)]
    n = len(x)
    for d, g in taps:
        s = int(d * sr)
        wet[s:] += low[: n - s] * g
    return wet


def main(argv):
    ap = argparse.ArgumentParser(description="render preview.wav from the music-data build")
    ap.add_argument("--sr", type=int, default=32000)
    ap.add_argument("--out", default=os.path.join(ROOT, "assets/audio/preview.wav"))
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--end", type=float, default=None)
    args = ap.parse_args(argv)

    notes, duration, sections, detail, source = build()
    sr = args.sr
    t0 = max(0.0, args.start)
    t1 = duration if args.end is None else min(duration, args.end)
    n = int((t1 + 3.5) * sr)
    buf = np.zeros(n, dtype=np.float32)

    kept = 0
    for note in notes:
        if note["t"] < t0 - 1.0 or note["t"] > t1:
            continue
        start, wave_ = render_note(note, sr)
        if start >= n:
            continue
        end = min(n, start + len(wave_))
        buf[start:end] += wave_[: end - start]
        kept += 1

    wet = simple_reverb(buf, sr)
    # feedback delay (eighth note at the arrangement bpm)
    d = int(round((60.0 / 94.0) * 0.5 * sr))
    delay = np.zeros_like(buf)
    delay[d:] += buf[: n - d] * 0.13
    delay[2 * d:] += buf[: n - 2 * d] * 0.05
    out = buf + 0.30 * wet + delay

    peak = float(np.max(np.abs(out)))
    if peak > 0:
        out *= 0.82 / peak   # normalize preview level
    # gentle fade-out on the last 1.2 s and fade-in on the first 10 ms
    fo = int(1.2 * sr)
    if len(out) > fo:
        out[-fo:] *= np.linspace(1.0, 0.0, fo).astype(np.float32)
    fi = int(0.01 * sr)
    out[:fi] *= np.linspace(0.0, 1.0, fi).astype(np.float32)

    pcm = np.clip(out * 32767.0, -32768, 32767).astype(np.int16)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with wave.open(args.out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())

    rms = float(np.sqrt(np.mean((pcm.astype(np.float32) / 32768.0) ** 2)))
    print("wrote %s" % args.out)
    print("  sr=%d  channels=1  bits=16  duration=%.2fs  notes=%d  size=%.2f MB  rms=%.3f  peak=%.2f" % (
        sr, len(pcm) / sr, kept, os.path.getsize(args.out) / 1e6, rms, peak))
    print("  sections:", [(s["name"], s["t"]) for s in sections])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
