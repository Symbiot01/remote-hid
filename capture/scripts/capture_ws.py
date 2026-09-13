#!/usr/bin/env python3
"""
Slice E — outbound WebSocket capture agent.

Connects to HID /ws/capture with CAPTURE_TOKEN (Pi initiates; no static IP).
On photo_req: optionally release whip.service, rpicam-still, restart whip.

Env:
  RELAY_WS_URL   wss://webrelay.example/ws/capture  (token query added if missing)
  CAPTURE_TOKEN  same secret as HID CAPTURE_TOKEN (≥16 chars)
  STILL_MIN_INTERVAL_S  default 2
  CAPTURE_RELEASE_WHIP  1 (default) — stop/start WHIP_SERVICE around still
  WHIP_SERVICE          default whip.service
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from camera_still import MAX_JPEG_BYTES, capture_jpeg  # noqa: E402

try:
    import websockets
    from websockets.exceptions import ConnectionClosed
except ImportError:
    print("Install websockets: pip install websockets", file=sys.stderr)
    raise SystemExit(1)

MIN_INTERVAL_S = float(os.environ.get("STILL_MIN_INTERVAL_S", "2"))
_last_capture = 0.0


def _load_dotenv() -> None:
    path = os.path.join(ROOT, ".env")
    if not os.path.isfile(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip().strip("'").strip('"')
            if key and key not in os.environ:
                os.environ[key] = val


def _ws_url() -> str:
    raw = (os.environ.get("RELAY_WS_URL") or "").strip()
    token = (os.environ.get("CAPTURE_TOKEN") or "").strip()
    if not raw:
        raise SystemExit("RELAY_WS_URL is required")
    if not token or len(token.encode("utf-8")) < 16:
        raise SystemExit("CAPTURE_TOKEN must be set (≥16 characters)")

    parsed = urlparse(raw)
    if parsed.scheme not in ("ws", "wss"):
        raise SystemExit("RELAY_WS_URL must be ws:// or wss://")

    qs = parse_qs(parsed.query, keep_blank_values=True)
    if "token" not in qs or not qs["token"] or not qs["token"][0]:
        qs["token"] = [token]
    flat = {k: v[0] if isinstance(v, list) else v for k, v in qs.items()}
    path = parsed.path or "/ws/capture"
    return urlunparse(
        (parsed.scheme, parsed.netloc, path, "", urlencode(flat), "")
    )


async def _handle_photo(ws, req_id: str) -> None:
    global _last_capture
    now = time.monotonic()
    if now - _last_capture < MIN_INTERVAL_S:
        await ws.send(json.dumps({"type": "photo_err", "id": req_id, "error": "rate limited"}))
        return
    print(f"photo_req id={req_id[:8]}…", flush=True)
    try:
        jpeg = await asyncio.to_thread(capture_jpeg)
    except Exception as exc:  # noqa: BLE001
        err = str(exc)[:200]
        print(f"photo_err id={req_id[:8]}… {err}", flush=True)
        await ws.send(json.dumps({"type": "photo_err", "id": req_id, "error": err}))
        return
    _last_capture = time.monotonic()
    print(f"photo_ok id={req_id[:8]}… bytes={len(jpeg)}", flush=True)
    await ws.send(json.dumps({"type": "photo_meta", "id": req_id, "bytes": len(jpeg)}))
    await ws.send(jpeg)


async def _session(url: str) -> None:
    parsed = urlparse(url)
    safe = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
    print(f"connecting {safe}", flush=True)
    async with websockets.connect(
        url,
        max_size=MAX_JPEG_BYTES + 1024,
        ping_interval=20,
        ping_timeout=20,
        close_timeout=5,
    ) as ws:
        print("capture ws connected", flush=True)
        async for message in ws:
            if isinstance(message, bytes):
                continue
            try:
                msg = json.loads(message)
            except json.JSONDecodeError:
                continue
            if not isinstance(msg, dict):
                continue
            if msg.get("type") == "pong":
                continue
            if msg.get("type") == "photo_req" and isinstance(msg.get("id"), str):
                await _handle_photo(ws, msg["id"])
                continue


async def main() -> None:
    _load_dotenv()
    url = _ws_url()
    delay = 1.0
    while True:
        try:
            await _session(url)
            delay = 1.0
        except ConnectionClosed as exc:
            print(f"disconnected code={exc.code}", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"session error: {type(exc).__name__}", flush=True)
        await asyncio.sleep(delay)
        delay = min(delay * 2, 60.0)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
