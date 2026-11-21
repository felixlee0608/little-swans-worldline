#!/usr/bin/env python3
"""Download the public-domain note source for the little-swans soundtrack.

Composition: P. I. Tchaikovsky, "Swan Lake", Op. 20, Act II, No. 13, IV
"Danse des petits cygnes" (Dance of the Little Swans) — public domain
(Tchaikovsky died 1893; first published 1877).

The MIDI used here is a literal piano transcription of the PD orchestral score
by the sequencer "yogore", hosted by Kunst der Fuge (kunstderfuge.com).  We only
extract the pitch / rhythm / velocity facts of the PD composition (a MIDI file is
just note data, not a recording), then re-orchestrate it with our own Web Audio
synthesis.  See docs/music-notes.md for the full provenance / licence note.

Usage:
    python3 tools/midi_fetch.py [--out assets/audio/source/...]

The file is already committed under assets/audio/source/ so the build is
reproducible offline; this script only re-creates it (and records the sha256).
"""

import argparse
import hashlib
import os
import sys
import urllib.request

# KDF serves the actual .mid from /-/mid.files/ after a "preparing download"
# bounce page; a normal browser UA + referer is enough for a plain GET.
KDF_PAGE = "https://www.kunstderfuge.com/-/midi.asp?file=%s"
KDF_FILE = "23/tchaikovsky_swan_lake_act-2_13d_allegro_moderato_(c)yogore.mid"
KDF_MID = "https://kunstderfuge.com/-/mid.files/" + KDF_FILE
REFERER = "https://www.kunstderfuge.com/tchaikovsky.htm"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"

DEFAULT_OUT = "little-swans/assets/audio/source/swan-lake-act2-13d-allegro-moderato.mid"


def fetch(url, out):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": REFERER})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    if data[:4] != b"MThd":
        raise SystemExit("downloaded data is not a MIDI file (got %d bytes)" % len(data))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "wb") as f:
        f.write(data)
    return data


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=DEFAULT_OUT)
    args = ap.parse_args(argv)
    data = fetch(KDF_MID, args.out)
    print("source   :", KDF_MID)
    print("page     :", KDF_PAGE % KDF_FILE)
    print("saved    :", args.out, "(%d bytes)" % len(data))
    print("sha256   :", hashlib.sha256(data).hexdigest())
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
