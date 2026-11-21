#!/usr/bin/env python3
"""Static dev server for little-swans.

    python3 tools/serve.py                 # http://127.0.0.1:8781/  (serves the project root)
    python3 tools/serve.py --port 9000
    python3 tools/serve.py --root .

MIME types are set for what the piece loads (JS modules, HDR, woff2). No-cache so a
reload always picks up edits; CORS and Range headers keep Chrome happy.
"""

from __future__ import annotations

import argparse
import functools
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

EXTRA_TYPES = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".hdr": "image/vnd.radiance",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".svg": "image/svg+xml",
    ".webmanifest": "application/manifest+json",
}


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, **EXTRA_TYPES}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def log_message(self, fmt, *args):
        if VERBOSE:
            super().log_message(fmt, *args)


def main() -> None:
    global VERBOSE
    ap = argparse.ArgumentParser(description="little-swans dev server")
    ap.add_argument("--port", type=int, default=8781)
    ap.add_argument("--root", default=ROOT)
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()
    VERBOSE = args.verbose
    handler = functools.partial(Handler, directory=args.root)
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    print(f"little-swans  →  http://127.0.0.1:{args.port}/   (root: {args.root})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


VERBOSE = False

if __name__ == "__main__":
    main()
