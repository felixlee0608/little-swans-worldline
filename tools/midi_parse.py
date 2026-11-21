#!/usr/bin/env python3
"""Standard MIDI File (SMF) parser used by the little-swans music pipeline.

Parses format 0/1 SMF into a list of note events with absolute time in *beats*
(quarter notes) and provides a tempo map so the builder can convert to seconds.

Usage:
    python3 tools/midi_parse.py FILE.mid                # human-readable summary
    python3 tools/midi_parse.py FILE.mid --json out.json
    python3 tools/midi_parse.py FILE.mid --dump-notes   # all notes as JSON on stdout

This module is re-used (import) by tools/midi-build.py.
No external dependencies.
"""

import argparse
import json
import struct
import sys


# ----------------------------------------------------------------------------
# SMF reader
# ----------------------------------------------------------------------------

def _read_vlq(data, pos):
    """Read a MIDI variable-length quantity. Returns (value, new_pos)."""
    value = 0
    while True:
        b = data[pos]
        pos += 1
        value = (value << 7) | (b & 0x7F)
        if not (b & 0x80):
            return value, pos


def parse_midi(path):
    """Parse an SMF file.

    Returns dict:
      format, division (ticks per quarter note),
      tracks: [ {name, channel_notes: {ch: [raw note tuples]}, tempos: [(tick, us_per_qn)],
                 time_sigs: [(tick, num, den)], program_changes: [(tick, ch, prog)],
                 n_events: int} ]
    raw note tuple = (start_tick, end_tick, channel, pitch, velocity)
    """
    with open(path, 'rb') as f:
        data = f.read()

    if data[:4] != b'MThd':
        raise ValueError('not a MIDI file (missing MThd): %s' % path)
    header_len = struct.unpack('>I', data[4:8])[0]
    midi_format, n_tracks, division = struct.unpack('>HHH', data[8:14])
    pos = 8 + header_len

    tracks = []
    for _ in range(n_tracks):
        if data[pos:pos + 4] != b'MTrk':
            raise ValueError('missing MTrk chunk at offset %d' % pos)
        track_len = struct.unpack('>I', data[pos + 4:pos + 8])[0]
        chunk = data[pos + 8:pos + 8 + track_len]
        pos += 8 + track_len
        tracks.append(_parse_track(chunk))

    # collect tempo map from all tracks (format 0 has it in track 0, format 1 in track 0)
    tempos = []
    for tr in tracks:
        for (tick, us) in tr['tempos']:
            tempos.append((tick, us))
    tempos.sort()
    if not tempos:
        tempos = [(0, 500000)]  # 120 bpm default

    return {
        'format': midi_format,
        'division': division,
        'tracks': tracks,
        'tempos': tempos,
    }


def _parse_track(chunk):
    pos = 0
    running_status = None
    abs_tick = 0
    active = {}           # (channel, pitch) -> (start_tick, velocity)
    notes = {}            # channel -> [note tuples]
    tempos = []
    time_sigs = []
    program_changes = []
    name = ''
    n_events = 0
    n = len(chunk)

    def get_notes(ch):
        if ch not in notes:
            notes[ch] = []
        return notes[ch]

    while pos < n:
        delta, pos = _read_vlq(chunk, pos)
        abs_tick += delta
        if pos >= n:
            break
        status = chunk[pos]
        n_events += 1
        if status < 0x80:
            # running status: reuse previous status byte
            if running_status is None:
                raise ValueError('running status without status byte')
            status = running_status
        else:
            pos += 1
            if status < 0xF0:
                running_status = status

        if status == 0xFF:  # meta
            meta_type = chunk[pos]
            pos += 1
            length, pos = _read_vlq(chunk, pos)
            payload = chunk[pos:pos + length]
            pos += length
            if meta_type == 0x03:
                name = payload.decode('latin-1', 'replace')
            elif meta_type == 0x51 and length == 3:
                us = (payload[0] << 16) | (payload[1] << 8) | payload[2]
                tempos.append((abs_tick, us))
            elif meta_type == 0x58 and length >= 2:
                time_sigs.append((abs_tick, payload[0], 2 ** payload[1]))
            elif meta_type == 0x2F:  # end of track
                break
        elif status in (0xF0, 0xF7):  # sysex
            length, pos = _read_vlq(chunk, pos)
            pos += length
        else:
            hi = status & 0xF0
            ch = status & 0x0F
            if hi in (0x80, 0x90, 0xA0, 0xB0, 0xE0):
                d1 = chunk[pos]
                d2 = chunk[pos + 1]
                pos += 2
                if hi == 0x90 and d2 > 0:
                    active[(ch, d1)] = (abs_tick, d2)
                elif hi == 0x80 or (hi == 0x90 and d2 == 0):
                    key = (ch, d1)
                    if key in active:
                        start, vel = active.pop(key)
                        get_notes(ch).append((start, abs_tick, ch, d1, vel))
                elif hi == 0xB0:
                    pass
            elif hi in (0xC0, 0xD0):
                d1 = chunk[pos]
                pos += 1
                if hi == 0xC0:
                    program_changes.append((abs_tick, ch, d1))
            else:
                # unknown status: bail out defensively
                break

    # unterminated notes: close at final tick
    for (ch, pitch), (start, vel) in active.items():
        get_notes(ch).append((start, abs_tick, ch, pitch, vel))

    for ch in notes:
        notes[ch].sort(key=lambda t: (t[0], t[3]))
    program_changes.sort()

    return {
        'name': name,
        'notes': notes,
        'tempos': sorted(tempos),
        'time_sigs': sorted(time_sigs),
        'program_changes': program_changes,
        'n_events': n_events,
        'end_tick': abs_tick,
    }


# ----------------------------------------------------------------------------
# tempo map helpers
# ----------------------------------------------------------------------------

def build_tempo_map(tempos, division):
    """Return list of (tick, seconds_at_tick, us_per_qn) sorted by tick."""
    out = []
    sec = 0.0
    prev_tick = 0
    prev_us = 500000
    for (tick, us) in sorted(tempos):
        sec += (tick - prev_tick) / division * (prev_us / 1e6)
        out.append((tick, sec, us))
        prev_tick, prev_us = tick, us
    return out


def tick_to_seconds(tick, tempo_map, division):
    """Convert absolute tick to seconds using a tempo map."""
    lo, hi = 0, len(tempo_map) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if tempo_map[mid][0] <= tick:
            lo = mid
        else:
            hi = mid - 1
    t_tick, t_sec, us = tempo_map[lo]
    return t_sec + (tick - t_tick) / division * (us / 1e6)


# ----------------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------------

def main(argv):
    ap = argparse.ArgumentParser(description='Parse a Standard MIDI File')
    ap.add_argument('file')
    ap.add_argument('--json', metavar='OUT', help='write parsed data as JSON')
    ap.add_argument('--dump-notes', action='store_true', help='print all notes as JSON')
    args = ap.parse_args(argv)

    m = parse_midi(args.file)
    division = m['division']
    tempo_map = build_tempo_map(m['tempos'], division)

    if args.dump_notes:
        all_notes = []
        for ti, tr in enumerate(m['tracks']):
            for ch, ns in tr['notes'].items():
                for (s, e, c, p, v) in ns:
                    all_notes.append({
                        'track': ti, 'trackName': tr['name'], 'ch': c, 'pitch': p,
                        'startTick': s, 'endTick': e,
                        't': round(tick_to_seconds(s, tempo_map, division), 4),
                        'dur': round(tick_to_seconds(e, tempo_map, division) - tick_to_seconds(s, tempo_map, division), 4),
                        'vel': v,
                    })
        all_notes.sort(key=lambda x: (x['t'], x['pitch']))
        print(json.dumps(all_notes, indent=1))
        return 0

    print('File:', args.file)
    print('format=%d division=%d tracks=%d' % (m['format'], division, len(m['tracks'])))
    total_tick = max((tr['end_tick'] for tr in m['tracks']), default=0)
    print('end tick=%d  duration=%.2fs' % (total_tick, tick_to_seconds(total_tick, tempo_map, division)))
    print('tempo events:', [(t, round(60e6 / us, 2)) for (t, us) in m['tempos']][:20])
    print('time signatures:', m['tracks'][0]['time_sigs'] if m['tracks'] else [])
    print()
    for ti, tr in enumerate(m['tracks']):
        pitches = [p for ns in tr['notes'].values() for (_, _, _, p, _) in ns]
        chans = sorted(tr['notes'].keys())
        programs = [(t, c, p) for (t, c, p) in tr['program_changes']][:8]
        if not pitches:
            print('track %2d %-28r events=%d  (no notes)' % (ti, tr['name'][:28], tr['n_events']))
            continue
        print('track %2d %-28r notes=%-5d ch=%-10s range=%s%d-%s%d programs=%s' % (
            ti, tr['name'][:28], len(pitches), chans,
            'midi', min(pitches), 'midi', max(pitches), programs[:4]))
    if args.json:
        with open(args.json, 'w') as f:
            json.dump({
                'format': m['format'], 'division': division,
                'tempos': m['tempos'], 'duration': tick_to_seconds(total_tick, tempo_map, division),
                'tracks': [{'name': tr['name'], 'endTick': tr['end_tick'],
                            'notes': tr['notes'], 'time_sigs': tr['time_sigs'],
                            'program_changes': tr['program_changes']} for tr in m['tracks']],
            }, f, indent=1)
        print('\nwrote', args.json)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
