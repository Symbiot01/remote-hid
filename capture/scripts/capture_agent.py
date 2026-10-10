#!/usr/bin/env python3
"""Outbound capture agent for the operator console.

The console owns the token. This process dials out and never prints it.

Environment:
  CAPTURE_URL    operator console, default http://127.0.0.1:8080
  CAPTURE_TOKEN  bearer token, required, at least 16 characters
  CAPTURE_JPEG   optional JPEG file sent when the console asks for a still
  CAPTURE_H264   optional Annex-B file uploaded once to the desk path
"""

from __future__ import annotations

import os
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def request(base: str, token: str, method: str, path: str, body: bytes | None, content_type: str | None):
    headers = {"Authorization": "Bearer " + token, "Accept": "application/json"}
    if content_type:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(base + path, data=body, method=method, headers=headers)
    timeout = 20 if method == "GET" else 30
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.status, res.read()


def upload_h264(base: str, token: str, path: Path) -> None:
    data = path.read_bytes()
    if not data:
        log("h264 file is empty")
        return
    try:
        status, _ = request(base, token, "POST", "/api/capture/h264", data, "application/octet-stream")
    except urllib.error.HTTPError as exc:
        log(f"h264 upload http {exc.code}")
        return
    except OSError:
        log("h264 upload failed")
        return
    log(f"h264 upload {status}")


def main() -> int:
    base = os.environ.get("CAPTURE_URL", "http://127.0.0.1:8080").rstrip("/")
    token = os.environ.get("CAPTURE_TOKEN", "")
    if len(token) < 16:
        log("CAPTURE_TOKEN is required")
        return 2
    jpeg_path = os.environ.get("CAPTURE_JPEG", "")
    h264_path = os.environ.get("CAPTURE_H264", "")
    if h264_path:
        threading.Thread(target=upload_h264, args=(base, token, Path(h264_path)), daemon=True).start()
    while True:
        try:
            _status, raw = request(base, token, "GET", "/api/capture/poll?wait=8", None, None)
        except urllib.error.HTTPError as exc:
            if exc.code == 401:
                log("capture token was rejected")
                return 1
            time.sleep(2 if exc.code == 409 else 1.5)
            continue
        except OSError:
            time.sleep(2)
            continue
        if b'"snap":true' not in raw and b'"snap": true' not in raw:
            continue
        if not jpeg_path:
            log("jpeg file is not configured")
            continue
        jpeg = Path(jpeg_path)
        if not jpeg.is_file():
            log("jpeg file is missing")
            continue
        try:
            status, _ = request(base, token, "POST", "/api/capture/jpeg", jpeg.read_bytes(), "image/jpeg")
        except urllib.error.HTTPError as exc:
            log(f"jpeg upload http {exc.code}")
            continue
        except OSError:
            log("jpeg upload failed")
            continue
        log(f"jpeg upload {status}")


if __name__ == "__main__":
    raise SystemExit(main())
