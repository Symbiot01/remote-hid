#!/usr/bin/env python3
"""
Slice D — local still capture HTTP (token required).

Optional LAN/debug only. Production Slice E uses scripts/capture_ws.py
(outbound WSS to HID /ws/capture) — no inbound CAPTURE_URL.

Uses camera_still.capture_jpeg (may briefly stop whip.service).

Env:
  STILL_HOST, STILL_PORT, CAPTURE_TOKEN
  CAPTURE_RELEASE_WHIP, WHIP_SERVICE (see camera_still.py)
"""

from __future__ import annotations

import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(os.path.dirname(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from camera_still import capture_jpeg  # noqa: E402

HOST = os.environ.get("STILL_HOST", "127.0.0.1")
PORT = int(os.environ.get("STILL_PORT", "8091"))
TOKEN = os.environ.get("CAPTURE_TOKEN", "").strip()
MIN_INTERVAL_S = float(os.environ.get("STILL_MIN_INTERVAL_S", "2"))

_last_capture = 0.0


def _authorized(handler: BaseHTTPRequestHandler) -> bool:
    if not TOKEN:
        return False
    auth = handler.headers.get("Authorization", "")
    if auth == f"Bearer {TOKEN}":
        return True
    return handler.headers.get("X-Capture-Token", "") == TOKEN


class StillHandler(BaseHTTPRequestHandler):
    server_version = "hid-capture-still/0.1"

    def log_message(self, fmt: str, *args) -> None:
        sys_stderr = __import__("sys").stderr
        print("%s - %s" % (self.address_string(), fmt % args), file=sys_stderr)

    def do_GET(self) -> None:
        if self.path in ("/healthz", "/health"):
            body = b'{"ok":true}\n'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(404)

    def do_POST(self) -> None:
        global _last_capture
        if self.path not in ("/still", "/still/"):
            self.send_error(404)
            return
        if not TOKEN:
            self.send_error(503, "CAPTURE_TOKEN not configured")
            return
        if not _authorized(self):
            self.send_error(401, "unauthorized")
            return
        now = time.monotonic()
        if now - _last_capture < MIN_INTERVAL_S:
            self.send_error(429, "rate limited")
            return
        try:
            jpeg = capture_jpeg()
        except Exception as exc:  # noqa: BLE001
            self.send_error(500, str(exc)[:200])
            return
        _last_capture = now
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(jpeg)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(jpeg)


def main() -> None:
    if HOST not in ("127.0.0.1", "localhost", "::1") and not TOKEN:
        raise SystemExit("Refusing non-localhost bind without CAPTURE_TOKEN")
    if not TOKEN:
        print("WARNING: CAPTURE_TOKEN empty — all /still requests will 503", flush=True)
    httpd = ThreadingHTTPServer((HOST, PORT), StillHandler)
    print(f"still listening on http://{HOST}:{PORT}  POST /still", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
