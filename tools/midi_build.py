#!/usr/bin/env python3
"""Build little-swans/src/music-data.js from the public-domain note source.

Pipeline
--------
assets/audio/source/swan-lake-act2-13d-allegro-moderato.mid   (Tchaikovsky, PD)
        -> tools/midi_parse.py        (raw SMF -> note list)
        -> voice classification       (lead / harm / pluck / bass)
        -> arrangement in *beats*     (intro -> A A -> B B -> reprise -> coda)
        -> src/music-data.js          ({notes:[{t,dur,midi,vel,inst}], bpm, duration, sections})

The arrangement is ours: 4-bar music-box intro, the complete PD dance from the
score (theme A twice, B section twice, reprise of A), and a long coda that ends
on a sustained F# minor chord (for the "porcelain freeze" ending).

Run:
    python3 tools/midi_build.py
"""

import hashlib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from midi_parse import parse_midi  # noqa: E402

SRC_MID = os.path.join(ROOT, "assets/audio/source/swan-lake-act2-13d-allegro-moderato.mid")
OUT_JS = os.path.join(ROOT, "src/music-data.js")

BPM = 94.0
SEC_PER_BEAT = 60.0 / BPM

# Source MIDI facts (division=480, quarter=480 ticks, constant tempo 115 in file;
# we re-time the note data to our own BPM, so the file's tempo is irrelevant).
DIV = 480
BAR_TICKS = 4 * DIV

# ---------------------------------------------------------------------------
# Arrangement plan.  All positions are *beats* of our own arrangement.
#   target_beat = target_start + (source_tick/480 - (src_bar0-1)*4)
# ---------------------------------------------------------------------------
PLAN = [
    # name,        target_start, src bar0, src bar1, intensity(0..1)
    ("theme_a1", 16, 2, 5, 0.68),
    ("theme_a2", 32, 6, 9, 0.76),
    ("middle_b1", 48, 10, 17, 0.84),
    ("middle_b2", 80, 18, 25, 0.92),
    ("reprise", 112, 26, 33, 0.98),
    ("coda_src", 144, 34, 37, 0.86),
]

INTRO_BEATS = 16
CODA_RING_BEATS = 24          # sustained final chord after the source coda
TOTAL_BEATS = 144 + 16 + CODA_RING_BEATS   # = 184

GRID = 60                      # quantise onsets to 1/8 beat (32nd notes)

NAME = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def pname(p):
    return NAME[p % 12] + str(p // 12 - 1)


def clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


# ---------------------------------------------------------------------------
# 1. read source notes grouped by quantised onset, per source bar range
# ---------------------------------------------------------------------------
def read_source_notes(midi, bar0, bar1):
    """Return { rel_start_beats: [(midi, src_vel, src_dur_beats, track), ...] }.

    rel_start_beats is measured from the beginning of bar0 (0.0 = bar0 beat 0).
    """
    tick0 = (bar0 - 1) * BAR_TICKS
    tick1 = bar1 * BAR_TICKS
    onsets = {}
    for ti, tr in enumerate(midi["tracks"]):
        if not tr["notes"]:
            continue
        for ch, ns in tr["notes"].items():
            for (s, e, c, p, v) in ns:
                if not (tick0 <= s < tick1):
                    continue
                q = round((s - tick0) / GRID) * GRID
                dur = round((e - s) / GRID) * GRID
                rel = (tick0 + q - (bar0 - 1) * BAR_TICKS) / float(DIV)
                onsets.setdefault(round(rel, 4), []).append(
                    (p, v, max(dur, GRID) / float(DIV), ti))
    return onsets


# ---------------------------------------------------------------------------
# 2. classify one onset chord into instrument voices
# ---------------------------------------------------------------------------
def classify(pitches, target_beats, scale):
    """pitches: [(midi, vel, dur_beats)] -> [(beat, dur, midi, vel, inst)].

    Voice rules (music-box arrangement of a piano reduction):
      highest note            -> 'lead'  (celesta / music box)
      next note within a 2..7 semitone span below it -> 'harm' (soft celesta 3rd)
      lowest note below B3    -> 'bass'  (plucked bass)
      remaining mid notes     -> up to two 'pluck' chord tones (pizzicato)
    """
    out = []
    if not pitches:
        return out
    pitches = sorted(set(pitches), key=lambda x: (-x[0], x[1]))
    ps = pitches
    if len(ps) == 1:
        p, v, d = ps[0]
        inst = "bass" if p <= 59 else ("bell" if p >= 86 else "lead")
        gain = {"bass": 0.72, "bell": 0.55, "lead": 0.92}[inst]
        out.append((target_beats, d, p, clamp(v / 110.0, 0.3, 0.95) * gain * scale, inst))
        return out

    lead = ps[0]
    out.append((target_beats, max(lead[2], 0.25),
                lead[0], clamp(lead[1] / 110.0, 0.35, 0.95) * 0.95 * scale, "lead"))
    rest = ps[1:]
    harm = None
    if rest:
        gap = lead[0] - rest[0][0]
        if 2 <= gap <= 7:
            harm = rest[0]
            rest = rest[1:]
    if harm is not None:
        out.append((target_beats, max(harm[2], 0.25), harm[0],
                    clamp(harm[1] / 110.0, 0.3, 0.9) * 0.62 * scale, "harm"))
    bass = None
    low = [x for x in rest if x[0] <= 59]
    if low:
        bass = min(low, key=lambda x: x[0])
        rest = [x for x in rest if x is not bass]
        out.append((target_beats, max(bass[2] * 2.0, 0.4), bass[0],
                    clamp(bass[1] / 110.0, 0.3, 0.9) * 0.78 * scale, "bass"))
    plucks = [x for x in rest if 55 <= x[0] <= 84]
    for x in plucks[:2]:
        out.append((target_beats, 0.32, x[0],
                    clamp(x[1] / 110.0, 0.25, 0.85) * 0.42 * scale, "pluck"))
    return out


# ---------------------------------------------------------------------------
# 3. section material from the source
# ---------------------------------------------------------------------------
def section_notes(midi, start_beat, bar0, bar1, scale, start_scale=None):
    groups = read_source_notes(midi, bar0, bar1)
    out = []
    n = len(groups)
    for i, rel in enumerate(sorted(groups)):
        target = start_beat + rel
        s = scale if start_scale is None else (
            start_scale + (scale - start_scale) * (i / max(1, n - 1)))
        pitches = [(p, v, d) for (p, v, d, ti) in groups[rel]]
        out.extend(classify(pitches, target, s))
    return out


# ---------------------------------------------------------------------------
# 4. hand-written intro (4 bars): F#m -> D -> C#7, music-box winding up
# ---------------------------------------------------------------------------
def intro_notes():
    notes = []

    def add(b, d, p, v, inst):
        notes.append((b, d, p, v, inst))

    # sustained pad (low root + fifth + octave)
    for (b, d, ps) in [
        (0, 8, (42, 49, 54, 61)),      # F#m
        (8, 4, (50, 57, 62, 66)),      # D
        (12, 4, (49, 56, 61, 65)),     # C#7 (F = E#)
    ]:
        for k, p in enumerate(ps):
            add(b, d, p, 0.34 - 0.04 * k, "pad")

    # plucked bass ostinato (eighths), rooted on the chord
    for (b0, b1, root, fifth) in [(0, 8, 42, 49), (8, 12, 50, 57), (12, 16, 49, 56)]:
        step = 0.5
        i = 0
        while b0 + i * step < b1 - 1e-6:
            p = root if i % 2 == 0 else fifth
            add(round(b0 + i * step, 3), 0.42, p, 0.30 if b0 == 0 else 0.36, "bass")
            i += 1

    # high bell pedal points
    for (b, d, p, v) in [(0, 6, 78, 0.48), (2, 5, 81, 0.42), (4, 5, 85, 0.40),
                         (6, 4, 90, 0.34), (8, 4, 86, 0.34), (12, 4, 85, 0.36)]:
        add(b, d, p, v, "bell")

    # celesta arpeggios, eighths
    arps = [
        (4, [66, 69, 73, 78, 81, 85, 81, 78]),       # F#4 A4 C#5 F#5 A5 C#6 ...
        (8, [62, 66, 69, 74, 78, 81, 78, 74]),       # D4 F#4 A4 D5 F#5 A5 ...
        (12, [61, 65, 68, 73, 68, 65, 68, 69]),      # C#4 F4 G#4 C#5 ... pickup G#4 A4
    ]
    for (b0, seq) in arps:
        for i, p in enumerate(seq):
            add(round(b0 + 0.5 * i, 3), 0.42, p, 0.30 + 0.02 * (i % 3), "lead")
    return notes


# ---------------------------------------------------------------------------
# 5. coda: sustained final F# minor chord (the "frozen sculpture" chord)
# ---------------------------------------------------------------------------
def coda_ring_notes(start_beat):
    notes = []
    b = start_beat

    def add(off, d, p, v, inst):
        notes.append((b + off, d, p, v, inst))

    # cadential C#7 -> F#m
    for p in (37, 49, 56, 65, 68):
        add(0.0, 1.1, p, 0.40, "pad")
    # the long F# minor chord, rolled like a music box arpeggio and left ringing
    roll = [30, 42, 49, 54, 61, 66, 69, 73, 78]
    for i, p in enumerate(roll):
        add(1.0 + 0.55 * i, 22.0 - 0.55 * i, p, 0.38 - 0.022 * i, "pad")
    # fading high bells
    for (off, d, p, v) in [(1.0, 10, 78, 0.34), (3.0, 8, 81, 0.28),
                           (5.0, 6, 85, 0.24), (8.0, 8, 90, 0.18)]:
        add(off, d, p, v, "bell")
    # soft echo of the theme cell (A A A A), very quiet
    for i in range(4):
        add(10.0 + 0.75 * i, 0.8, 69, 0.16, "lead")
    return notes


# ---------------------------------------------------------------------------
# 6. extra sparkle / octave doubling in the climactic sections
# ---------------------------------------------------------------------------
def add_doublings(notes):
    out = []
    for (b, d, p, v, inst) in notes:
        out.append((b, d, p, v, inst))
        if inst == "lead" and p <= 84 and v > 0.5:
            section = "a2" if 32 <= b < 48 else "b2" if 80 <= b < 112 else "rep" if 112 <= b < 144 else None
            if section in ("b2", "rep"):
                out.append((b + 0.008, d, p + 12, v * 0.32, "bell"))
    return out


# ---------------------------------------------------------------------------
# 7. assemble
# ---------------------------------------------------------------------------
def build():
    midi = parse_midi(SRC_MID)
    notes = []

    notes.extend(intro_notes())

    for (name, start, bar0, bar1, scale) in PLAN:
        # reprise = bars 26-33 (A once low, once an octave up)
        notes.extend(section_notes(midi, start, bar0, bar1, scale))

    notes.extend(coda_ring_notes(160))

    # gradual global fade over the very end (coda ring already decays)
    doubled = add_doublings(notes)

    # normalise / sort / dedupe identical onsets
    seen = set()
    final = []
    for (b, d, p, v, inst) in doubled:
        b = round(b, 3)
        key = (round(b, 2), p, inst)
        if key in seen:
            continue
        seen.add(key)
        final.append({
            "t": round(b * SEC_PER_BEAT, 3),
            "dur": round(clamp(d * SEC_PER_BEAT, 0.06, 16.0), 3),
            "midi": int(p),
            "vel": round(clamp(v, 0.05, 0.98), 3),
            "inst": inst,
        })
    final.sort(key=lambda n: (n["t"], n["midi"]))

    duration = round(TOTAL_BEATS * SEC_PER_BEAT, 3)
    sections = [
        {"name": "intro", "t": 0.0, "dur": round(INTRO_BEATS * SEC_PER_BEAT, 3)},
        {"name": "theme", "t": round(16 * SEC_PER_BEAT, 3),
         "dur": round(32 * SEC_PER_BEAT, 3)},
        {"name": "middle", "t": round(48 * SEC_PER_BEAT, 3),
         "dur": round(64 * SEC_PER_BEAT, 3)},
        {"name": "reprise", "t": round(112 * SEC_PER_BEAT, 3),
         "dur": round(32 * SEC_PER_BEAT, 3)},
        {"name": "coda", "t": round(144 * SEC_PER_BEAT, 3),
         "dur": round(40 * SEC_PER_BEAT, 3)},
    ]
    # fine-grained section list (useful for HUD / choreography accents)
    detail = []
    for (name, start, bar0, bar1, _s) in PLAN:
        detail.append({
            "name": "coda" if name == "coda_src" else name,
            "t": round(start * SEC_PER_BEAT, 3),
            "beats": (bar1 - bar0 + 1) * 4,
        })
    for d in detail:
        d["dur"] = round(d["beats"] * SEC_PER_BEAT, 3)
    detail.append({"name": "coda_ring", "t": round(160 * SEC_PER_BEAT, 3),
                   "dur": round(24 * SEC_PER_BEAT, 3), "beats": 24})

    with open(SRC_MID, "rb") as f:
        sha = hashlib.sha256(f.read()).hexdigest()
    source = {
        "work": "Danse des petits cygnes (Dance of the Little Swans), Swan Lake Op. 20, Act II No. 13 IV",
        "composer": "Pyotr Ilyich Tchaikovsky (1840-1893)",
        "status": "composition public domain",
        "midiTitle": "tchaikovsky_swan_lake_act-2_13d_allegro_moderato (piano transcription)",
        "sequencer": "yogore",
        "host": "Kunst der Fuge (kunstderfuge.com)",
        "url": "https://www.kunstderfuge.com/-/midi.asp?file=23/tchaikovsky_swan_lake_act-2_13d_allegro_moderato_(c)yogore.mid",
        "retrieved": "2026-10-27",
        "sha256": sha,
        "arrangement": "ours: 4-bar music-box intro + complete PD dance (A A / B B / A) + extended coda on a sustained F# minor chord",
        "license": "composition PD; only pitch/rhythm facts extracted and re-orchestrated with our own Web Audio synthesis",
    }
    return final, duration, sections, detail, source


def fmt_num(x):
    s = ("%.3f" % x).rstrip("0").rstrip(".")
    return s if s else "0"


def write_js(notes, duration, sections, detail, source):
    lines = []
    lines.append("// AUTO-GENERATED by tools/midi_build.py -- 不要手改；改源 MIDI 或脚本后重跑。")
    lines.append("//")
    lines.append("// 曲目：柴可夫斯基《天鹅湖》Op.20 第二幕 No.13 IV《四小天鹅舞曲》(Danse des petits cygnes)")
    lines.append("// 曲目公版（作曲 1893 年去世）。音符数据由公版乐谱的钢琴缩谱 MIDI 提取，")
    lines.append("// 重新编配/配器由本项目完成；只用音高/时值/力度事实，不使用任何音源文件。")
    lines.append("// 详见 docs/music-notes.md。")
    lines.append("")
    lines.append("export const bpm = %s;" % fmt_num(BPM))
    lines.append("export const duration = %s;" % fmt_num(duration))
    lines.append("")
    lines.append("export const sections = [")
    for s in sections:
        lines.append("  { name: %r, t: %s, dur: %s }," % (s["name"], fmt_num(s["t"]), fmt_num(s["dur"])))
    lines.append("];")
    lines.append("")
    lines.append("export const sectionsDetail = [")
    for s in detail:
        lines.append("  { name: %r, t: %s, dur: %s, beats: %d }," % (
            s["name"], fmt_num(s["t"]), fmt_num(s["dur"]), s["beats"]))
    lines.append("];")
    lines.append("")
    lines.append("export const source = {")
    for k, v in source.items():
        lines.append("  %s: %r," % (k, v))
    lines.append("};")
    lines.append("")
    lines.append("// { t: 起点秒, dur: 时长秒, midi: 音高(0-127), vel: 力度(0-1), inst: 音色 }")
    lines.append("// inst: lead=钢片琴/音乐盒主旋律, harm=柔和三度内声部, pluck=拨弦内声部,")
    lines.append("//       bass=拨弦低音, pad=长音铺底, bell=高音铃")
    lines.append("export const notes = [")
    for n in notes:
        lines.append("  {t:%s,dur:%s,midi:%d,vel:%s,inst:%r}," % (
            fmt_num(n["t"]), fmt_num(n["dur"]), n["midi"], fmt_num(n["vel"]), n["inst"]))
    lines.append("];")
    lines.append("")
    lines.append("export default { bpm, duration, sections, sectionsDetail, source, notes };")
    lines.append("")
    os.makedirs(os.path.dirname(OUT_JS), exist_ok=True)
    with open(OUT_JS, "w") as f:
        f.write("\n".join(lines))
    return OUT_JS


def main():
    notes, duration, sections, detail, source = build()
    path = write_js(notes, duration, sections, detail, source)

    # ---- validation ----
    ts = [n["t"] for n in notes]
    assert ts == sorted(ts), "notes not sorted by time"
    assert notes, "empty note array"
    assert all(0 <= n["midi"] <= 127 for n in notes), "bad midi pitch"
    assert all(n["dur"] > 0 for n in notes), "bad duration"
    assert 110.0 <= duration <= 125.0, "duration out of 110-125s: %s" % duration
    assert ts[-1] < duration + 0.5

    counts = {}
    for n in notes:
        counts[n["inst"]] = counts.get(n["inst"], 0) + 1
    print("wrote %s" % path)
    print("notes: %d   duration: %.2fs   bpm: %g" % (len(notes), duration, BPM))
    print("inst counts:", counts)
    print("pitch range: %s .. %s" % (pname(min(n["midi"] for n in notes)),
                                     pname(max(n["midi"] for n in notes))))
    print("last note t=%.2fs" % ts[-1])
    print("sections:", [(s["name"], s["t"], s["dur"]) for s in sections])
    print("sectionsDetail:", [(s["name"], s["t"], s["dur"]) for s in detail])

    # quick melodic sanity: first few 'lead' notes of the theme
    leads = [n for n in notes if n["inst"] == "lead" and 10.0 <= n["t"] <= 21.0]
    print("theme melody head:", " ".join(pname(n["midi"]) for n in leads[:24]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
