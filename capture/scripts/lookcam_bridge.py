#!/usr/bin/env python3
"""LookCam PPPP bridge.

Keeps the camera session up, retries when the module drops, and obeys the
operator server. Video bytes are Annex-B only. The server transcodes them.

The device password arrives once over the bearer channel. It is not written
to logs or to the browser.

Environment:
  BRIDGE_URL          operator console, default http://127.0.0.1:8080
  BRIDGE_TOKEN        bearer token, required
  LOOKCAM_DEVICE      default GHBB-522328-BWDTT
  LOOKCAM_IP          optional unicast search target, default 192.168.100.1
  LOOKCAM_BIND        local address to bind, default 0.0.0.0
  LOOKCAM_IFACE       optional interface (wlo1 on the laptop). Needs permission.
"""

from __future__ import annotations

import json
import os
import queue
import select
import socket
import struct
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from http.client import HTTPConnection, HTTPSConnection

UID_HEX = "47484242000000000007f8584257445454000000"
FRAME_MARK = b"\x01\xaf\xaf\xaf"
VIDEO_HEADER = 83
SEARCH_PORT = 32108
ZONE_HOURS = 5
ZONE_SECONDS = 19800

READS = {
    "GetDevInfo",
    "GetDevStream",
    "GetDevVideoInfo",
    "GetAlarmInfo",
    "GetLedInfo",
    "searchWiFiList",
}
NO_REPLY = {"SetDevVideoInfo", "LevelFlip", "VerticalFlip", "SetLed"}
ALLOWED = READS | NO_REPLY | {"SetAlarmInfo", "SetLedInfo", "OpenWifi", "ModifyPwd"}


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def pack_uid(device: str) -> bytes:
    prefix, serial, suffix = device.split("-", 2)
    if not serial.isdigit() or int(serial) > 0xFFFFFFFF:
        raise ValueError("bad device id")
    raw = prefix.encode("ascii")[:4].ljust(4, b"\0")
    raw += b"\0" * 4
    raw += struct.pack(">I", int(serial))
    raw += suffix.encode("ascii")[:8].ljust(8, b"\0")
    if len(raw) != 20:
        raise ValueError("bad device id")
    return raw


def pppp(typ: int, body: bytes = b"") -> bytes:
    return bytes((0xF1, typ)) + struct.pack(">H", len(body)) + body


def drw(channel: int, index: int, payload: bytes) -> bytes:
    body = bytes((0xD1, channel)) + struct.pack(">H", index & 0xFFFF) + payload
    return pppp(0xD0, body)


def drw_ack(channel: int, index: int) -> bytes:
    body = bytes((0xD1, channel, 0x00, 0x01)) + struct.pack(">H", index & 0xFFFF)
    return pppp(0xD1, body)


def encode_json(text: str) -> bytes:
    body = text.encode("utf-8")
    out = bytearray(26 + len(body) + 4)
    struct.pack_into("<I", out, 0, 0xAFAFAFA0)
    out[4] = 0
    out[5] = ZONE_HOURS & 0xFF
    struct.pack_into("<q", out, 6, int(time.time()) + ZONE_HOURS * 3600)
    struct.pack_into("<I", out, 0x16, len(body))
    out[26 : 26 + len(body)] = body
    struct.pack_into("<I", out, 26 + len(body), 0xF1F2F3F4)
    return bytes(out)


def parse_json(payload: bytes):
    start = payload.find(b"{")
    end = payload.rfind(b"}")
    if start < 0 or end <= start:
        return None
    try:
        msg = json.loads(payload[start : end + 1])
    except json.JSONDecodeError:
        return None
    return msg if isinstance(msg, dict) else None


def public_body(msg):
    if not isinstance(msg, dict):
        return None
    out = {}
    for key, value in msg.items():
        if "pwd" in key.lower() or "password" in key.lower():
            continue
        if key == "value" and isinstance(value, list):
            out[key] = value[:40]
        else:
            out[key] = value
    return out


def selftest() -> None:
    assert pack_uid("GHBB-522328-BWDTT").hex() == UID_HEX
    assert pppp(0x30) == bytes.fromhex("f1300000")
    framed = encode_json('{"cmd":"GetDevInfo"}')
    assert framed[:4] == bytes.fromhex("a0afafaf")
    assert framed[-4:] == bytes.fromhex("f4f3f2f1")
    assert struct.unpack_from("<I", framed, 0x16)[0] == len(b'{"cmd":"GetDevInfo"}')


class H264Upload:
    def __init__(self, base: str, token: str) -> None:
        self.base = base
        self.token = token
        self.box: queue.Queue[bytes | None] = queue.Queue(maxsize=200)
        self.stop = threading.Event()
        self.thread: threading.Thread | None = None
        self.connected = False
        self.error = ""

    def offer(self, data: bytes) -> None:
        if self.stop.is_set() or not data:
            return
        try:
            self.box.put_nowait(data)
        except queue.Full:
            try:
                self.box.get_nowait()
            except queue.Empty:
                pass
            try:
                self.box.put_nowait(data)
            except queue.Full:
                pass

    def ensure(self) -> None:
        if self.thread and self.thread.is_alive():
            return
        self.stop.clear()
        self.thread = threading.Thread(target=self._run, name="h264", daemon=True)
        self.thread.start()

    def halt(self) -> None:
        self.stop.set()
        try:
            self.box.put_nowait(None)
        except queue.Full:
            pass

    def _run(self) -> None:
        while not self.stop.is_set():
            try:
                self._post()
            except Exception:
                self.connected = False
                self.error = "upload failed"
                time.sleep(1.5)

    def _post(self) -> None:
        parsed = urllib.parse.urlparse(self.base)
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        path = (parsed.path or "").rstrip("/") + "/api/bridge/h264"
        conn = HTTPSConnection(host, port, timeout=20) if parsed.scheme == "https" else HTTPConnection(host, port, timeout=20)
        try:
            conn.putrequest("POST", path)
            conn.putheader("Authorization", "Bearer " + self.token)
            conn.putheader("Content-Type", "application/octet-stream")
            conn.putheader("Transfer-Encoding", "chunked")
            conn.endheaders()
            while not self.stop.is_set():
                try:
                    item = self.box.get(timeout=0.5)
                except queue.Empty:
                    continue
                if item is None:
                    break
                conn.send(b"%X\r\n%s\r\n" % (len(item), item))
            conn.send(b"0\r\n\r\n")
            resp = conn.getresponse()
            resp.read()
            self.connected = resp.status == 200
            self.error = "" if resp.status == 200 else f"http {resp.status}"
            if resp.status == 401:
                log("bridge token was rejected")
                self.stop.set()
            elif resp.status == 409:
                self.error = "ingest busy"
                time.sleep(2)
        finally:
            conn.close()
            self.connected = False


class Bridge:
    def __init__(self) -> None:
        self.base = os.environ.get("BRIDGE_URL", "http://127.0.0.1:8080").rstrip("/")
        self.token = os.environ.get("BRIDGE_TOKEN", "")
        self.device = os.environ.get("LOOKCAM_DEVICE", "GHBB-522328-BWDTT")
        self.camera_ip = os.environ.get("LOOKCAM_IP", "192.168.100.1")
        self.bind = os.environ.get("LOOKCAM_BIND", "") or "0.0.0.0"
        self.iface = os.environ.get("LOOKCAM_IFACE", "")
        self.uid = pack_uid(self.device)
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.outbox: queue.Queue[tuple[str, dict]] = queue.Queue(maxsize=32)
        self.commands: deque[dict] = deque()
        self.video_desired = False
        self.stream = 2
        self.password = ""
        self.configured = False
        self.password_changed = False
        self.force_reconnect = False
        self.pump = H264Upload(self.base, self.token)
        self.attempt = 1
        self.phase = "searching"
        self.detail = "looking for the camera"
        self._reset_session()

    def _reset_session(self) -> None:
        self.peer = None
        self.ready = False
        self.login_ok = False
        self.clock_ok = False
        self.video_open = False
        self.opened_stream = 2
        self.video_next = None
        self.video_buf: dict[int, bytes] = {}
        self.video_bytes = 0
        self.last_video = 0.0
        self.video_opened_at = 0.0
        self.last_rx = time.monotonic()
        self.last_search = 0.0
        self.last_punch = 0.0
        self.last_alive = 0.0
        self.peer_since = 0.0
        self.cmd_idx = 0
        self.userid = 1
        self.pending = None
        self.stalls = 0
        self.next_video_try = 0.0
        self.rediscover_at = 0.0
        self.backoff_until = 0.0
        self.pump.halt()

    def run(self) -> int:
        if len(self.token) < 16:
            log("BRIDGE_TOKEN is required")
            return 2
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 * 1024 * 1024)
            if self.iface:
                try:
                    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, self.iface.encode())
                except OSError as exc:
                    log(f"could not bind to {self.iface}: {exc}")
            sock.bind((self.bind, 0))
            sock.setblocking(False)
        except OSError as exc:
            log(f"socket failed: {exc}")
            return 2
        log(f"bound {sock.getsockname()[0]}:{sock.getsockname()[1]}")
        threading.Thread(target=self._poll_loop, name="poll", daemon=True).start()
        threading.Thread(target=self._report_loop, name="report", daemon=True).start()
        last_status = 0.0
        try:
            while not self.stop.is_set():
                now = time.monotonic()
                self._housekeeping(sock, now)
                if now - last_status > 3:
                    self._push_status()
                    last_status = now
                try:
                    readable, _, _ = select.select([sock], [], [], 0.1)
                except (InterruptedError, OSError):
                    break
                if not readable:
                    continue
                while True:
                    try:
                        data, addr = sock.recvfrom(65535)
                    except BlockingIOError:
                        break
                    except OSError:
                        break
                    self._on_packet(sock, data, addr)
        finally:
            self.pump.halt()
            sock.close()
        return 0

    def _housekeeping(self, sock: socket.socket, now: float) -> None:
        if self.rediscover_at and now >= self.rediscover_at:
            self.rediscover_at = 0.0
            self._reset("camera changed network")
            return
        if self.peer and now - self.last_rx > 8:
            self._reset("session went quiet")
            return
        if not self.peer and now >= self.backoff_until and now - self.last_search > 0.4:
            self._search(sock)
            self.last_search = now
            self._set_phase("searching", "looking for the camera")
        if self.peer and not self.ready and now - self.last_punch > 0.25:
            self._send(sock, pppp(0x41, self.uid))
            self.last_punch = now
            self._set_phase("punching", "waiting for ready")
        if self.peer and not self.ready and now - self.peer_since > 4:
            self._reset("punch timed out")
            return
        if self.ready and now - self.last_alive > 1:
            self._send(sock, pppp(0xE0))
            self.last_alive = now
        self._tick_pending(sock, now)
        if self.pending:
            return
        if self._take_reconnect():
            self._reset("reconnect requested")
            return
        if self.ready and not self.login_ok and now >= self.next_video_try:
            if not self.password:
                self._set_phase("login", "camera password is not configured")
                self.next_video_try = now + 3
                return
            self._begin(sock, "LoginDev", {"pwd": self.password, "cmd": "LoginDev"}, "login", True)
            return
        if self.login_ok and not self.clock_ok:
            self._begin(
                sock,
                "AppointDev",
                {
                    "state": 3,
                    "pwd": self.password,
                    "zone": ZONE_HOURS,
                    "zone_s": ZONE_SECONDS,
                    "time": int(time.time()),
                    "cmd": "AppointDev",
                },
                "clock",
                True,
            )
            return
        if not self.clock_ok:
            return
        command = self._pop_command()
        if command:
            self._begin_user(sock, command)
            return
        desired, stream = self._desired()
        if self.video_open and desired and (self.last_video or self.video_opened_at) and now - (
            self.last_video or self.video_opened_at
        ) > 3.5:
            self.stalls += 1
            if self.stalls >= 4:
                self._reset("video stalled")
                return
            self._set_phase("recovering", "reopening video")
            self._begin_video(sock, 2, stream)
            return
        if desired and self.video_open and stream != self.opened_stream:
            self._begin_video(sock, 0, self.opened_stream)
            return
        if desired and not self.video_open and now >= self.next_video_try:
            self._begin_video(sock, 2, stream)
            return
        if not desired and self.video_open:
            self._begin_video(sock, 0, self.opened_stream)
            return
        if self.video_open and self.last_video and now - self.last_video < 2.5:
            self._set_phase("streaming", "bytes flowing")
        elif self.clock_ok:
            self._set_phase("ready", "session up")

    def _tick_pending(self, sock: socket.socket, now: float) -> None:
        pending = self.pending
        if not pending:
            return
        age = now - pending["sent"]
        if not pending["acked"] and age > 1.2:
            if pending["tries"] >= 4:
                self._finish(False, "no acknowledgement", None)
            else:
                self._transmit(sock)
        elif pending["need_json"] and pending["acked"] and age > 2.5:
            if pending["tries"] >= 4:
                self._finish(False, "no reply", None)
            else:
                pending["acked"] = False
                self._transmit(sock)

    def _begin(self, sock: socket.socket, name: str, body: dict, kind: str, need_json: bool) -> None:
        self.pending = {
            "id": None,
            "name": name,
            "body": body,
            "kind": kind,
            "need_json": need_json,
            "index": self._next_index(),
            "tries": 0,
            "sent": 0.0,
            "acked": False,
            "args": {},
        }
        if kind == "login":
            self._set_phase("login", "LoginDev")
        elif kind == "clock":
            self._set_phase("clock", "setting the clock")
        self._transmit(sock)

    def _begin_video(self, sock: socket.socket, state: int, stream: int) -> None:
        self.pending = {
            "id": None,
            "name": "OpenVideo",
            "body": {
                "state": state,
                "pwd": self.password,
                "stream": stream,
                "userid": self.userid,
                "cmd": "OpenVideo",
            },
            "kind": "video-start" if state == 2 else "video-stop",
            "need_json": False,
            "index": self._next_index(),
            "tries": 0,
            "sent": 0.0,
            "acked": False,
            "args": {"stream": stream},
        }
        self.userid = self.userid + 1 if self.userid < 60000 else 1
        self._set_phase("opening", "starting video" if state == 2 else "stopping video")
        self._transmit(sock)

    def _begin_user(self, sock: socket.socket, command: dict) -> None:
        name = command.get("name")
        args = command.get("args") if isinstance(command.get("args"), dict) else {}
        if name not in ALLOWED:
            self._enqueue_result(command.get("id"), False, "unknown command", None)
            return
        body = self._camera_body(name, args)
        if body is None:
            self._enqueue_result(command.get("id"), False, "camera password is not configured", None)
            return
        self.pending = {
            "id": command.get("id"),
            "name": name,
            "body": body,
            "kind": "user",
            "need_json": name not in NO_REPLY,
            "index": self._next_index(),
            "tries": 0,
            "sent": 0.0,
            "acked": False,
            "args": args,
        }
        log(f"command {name}")
        self._transmit(sock)

    def _camera_body(self, name: str, args: dict):
        if name == "ModifyPwd":
            if not self.password:
                return None
            return {"pwd": self.password, "newpwd": args.get("newpwd", ""), "cmd": name}
        if name == "OpenWifi":
            return {"sid": args.get("sid", ""), "wifiPwd": args.get("wifiPwd", ""), "state": 1, "cmd": name}
        body = {"cmd": name}
        body.update(args)
        body["cmd"] = name
        return body

    def _transmit(self, sock: socket.socket) -> None:
        pending = self.pending
        if not pending:
            return
        raw = json.dumps(pending["body"], separators=(",", ":"))
        self._send(sock, drw(1, pending["index"], encode_json(raw)))
        pending["tries"] += 1
        pending["sent"] = time.monotonic()

    def _finish(self, ok: bool, detail: str, msg) -> None:
        pending = self.pending
        self.pending = None
        if not pending:
            return
        kind = pending["kind"]
        name = pending["name"]
        if kind == "login":
            result = msg.get("result") if isinstance(msg, dict) else None
            self.login_ok = ok and result == 0
            log(f"login result={result}")
            if not self.login_ok:
                self.next_video_try = time.monotonic() + min(15, 3 * max(1, self.attempt))
                self._set_phase("login", "login was rejected")
            return
        if kind == "clock":
            state = msg.get("state") if isinstance(msg, dict) else None
            self.clock_ok = ok and state == 0
            log(f"appoint state={state}")
            if not self.clock_ok:
                self.login_ok = False
            return
        if kind == "video-start" and ok:
            self.video_open = True
            self.opened_stream = pending["args"].get("stream", 2)
            self.video_next = None
            self.video_buf.clear()
            self.video_opened_at = time.monotonic()
            self.stalls = 0
            return
        if kind == "video-stop" and ok:
            self.video_open = False
            self.pump.halt()
            return
        if kind != "user":
            if not ok:
                self.next_video_try = time.monotonic() + 2
            return
        if name == "ModifyPwd" and isinstance(msg, dict) and msg.get("result") == 0:
            newpwd = pending["args"].get("newpwd")
            if isinstance(newpwd, str) and newpwd:
                self.password = newpwd
                self.password_changed = True
        if name == "OpenWifi" and ok:
            self.rediscover_at = time.monotonic() + 1.5
            detail = "camera is joining the network"
        if name in NO_REPLY and ok:
            detail = "Acknowledged. The camera sent no JSON."
        log(f"{name} {'ok' if ok else 'failed'}")
        self._enqueue_result(pending["id"], ok, detail, public_body(msg))

    def _on_packet(self, sock: socket.socket, data: bytes, addr) -> None:
        if len(data) < 4 or data[0] != 0xF1:
            return
        declared = struct.unpack_from(">H", data, 2)[0]
        if declared > 60_000 or len(data) < 4 + declared:
            return
        body = data[4 : 4 + declared]
        typ = data[1]
        if self.peer and addr[0] != self.peer[0]:
            return
        if typ == 0x41 and body[:20] == self.uid and not self.ready:
            self.peer = addr
            self.peer_since = time.monotonic()
            self.last_rx = self.peer_since
            self._send(sock, pppp(0x41, self.uid))
            self.last_punch = time.monotonic()
            log(f"punch from {addr[0]}:{addr[1]}")
            return
        if typ == 0x42 and (body[:20] == self.uid or (self.peer and addr[0] == self.peer[0])):
            self.last_rx = time.monotonic()
            if not self.ready:
                self.peer = addr
                self.ready = True
                log(f"session ready {addr[1]}")
                self._send(sock, pppp(0xE0))
                self._send(sock, drw_ack(7, 0xAAAA))
                self.last_alive = time.monotonic()
            return
        if not self.peer or addr[0] != self.peer[0]:
            return
        self.last_rx = time.monotonic()
        if typ == 0xE0:
            self._send(sock, pppp(0xE1))
        elif typ == 0xF0:
            self._reset("camera closed the session")
        elif typ == 0xD1 and len(body) >= 4 and body[0] == 0xD1:
            channel = body[1]
            if len(body) >= 6 and body[2] == 0 and body[3] == 1:
                index = struct.unpack_from(">H", body, 4)[0]
            else:
                index = struct.unpack_from(">H", body, 2)[0]
            if self.pending and channel == 1 and index == self.pending["index"]:
                self.pending["acked"] = True
                if not self.pending["need_json"]:
                    self._finish(True, "acknowledged", None)
        elif typ == 0xD0 and len(body) >= 4 and body[0] == 0xD1:
            channel = body[1]
            index = struct.unpack_from(">H", body, 2)[0]
            payload = body[4:]
            self._send(sock, drw_ack(channel, index))
            if channel == 1:
                msg = parse_json(payload)
                if msg and self.pending and msg.get("cmd") == self.pending["name"]:
                    self._finish(True, "ok", msg)
            elif channel == 0 and self.video_open:
                self._take_video(index, payload)

    def _take_video(self, index: int, payload: bytes) -> None:
        if self.video_next is not None and index == (self.video_next - 1) & 0xFFFF:
            return
        if index in self.video_buf:
            return
        self.video_buf[index] = payload
        if self.video_next is None:
            self.video_next = index
        while self.video_next in self.video_buf:
            body = self.video_buf.pop(self.video_next)
            chunk = body[VIDEO_HEADER:] if body.startswith(FRAME_MARK) and len(body) > VIDEO_HEADER else body
            if chunk:
                self.video_bytes += len(chunk)
                self.last_video = time.monotonic()
                self.stalls = 0
                desired, _stream = self._desired()
                if desired:
                    self.pump.offer(chunk)
                    self.pump.ensure()
            self.video_next = (self.video_next + 1) & 0xFFFF
        if len(self.video_buf) > 64 and self.video_next not in self.video_buf:
            self.video_next = (self.video_next + 1) & 0xFFFF

    def _search(self, sock: socket.socket) -> None:
        pkt = pppp(0x30)
        for target in ((self.camera_ip, SEARCH_PORT), ("255.255.255.255", SEARCH_PORT)):
            try:
                sock.sendto(pkt, target)
            except OSError:
                continue

    def _send(self, sock: socket.socket, pkt: bytes) -> None:
        if not self.peer:
            return
        try:
            sock.sendto(pkt, self.peer)
        except OSError as exc:
            log(f"send error {exc}")

    def _next_index(self) -> int:
        index = self.cmd_idx
        self.cmd_idx = (self.cmd_idx + 1) & 0xFFFF
        return index

    def _reset(self, reason: str) -> None:
        self.attempt += 1
        delay = min(8.0, 0.4 * (2 ** min(self.attempt, 4)))
        self._reset_session()
        self.backoff_until = time.monotonic() + delay
        self._set_phase("searching", reason)
        log(f"recover attempt={self.attempt} {reason}")

    def _set_phase(self, phase: str, detail: str) -> None:
        if phase == self.phase and detail == self.detail:
            return
        self.phase = phase
        self.detail = detail

    def _desired(self):
        with self.lock:
            return self.video_desired, self.stream

    def _take_reconnect(self) -> bool:
        with self.lock:
            if not self.force_reconnect:
                return False
            self.force_reconnect = False
            return True

    def _pop_command(self):
        with self.lock:
            if not self.commands:
                return None
            return self.commands.popleft()

    def _configure(self, command: dict) -> None:
        password = command.get("password")
        with self.lock:
            if isinstance(password, str) and not self.password_changed:
                self.password = password
            self.configured = True
        self._enqueue_result(command.get("id"), True, "configured", None)

    def _enqueue_result(self, ident, ok: bool, detail: str, body) -> None:
        if not isinstance(ident, str):
            return
        self._put_outbox(("/api/bridge/result", {"id": ident, "ok": ok, "detail": detail, "body": body}))

    def _push_status(self) -> None:
        now = time.monotonic()
        desired, _stream = self._desired()
        if not desired:
            video = "off"
        elif self.video_open and self.last_video and now - self.last_video < 2.5:
            video = "on"
        else:
            video = "starting"
        with self.lock:
            needs_password = not self.configured
        checks = [
            {"name": "search", "ok": self.peer is not None or self.ready, "detail": "found" if self.peer else "searching"},
            {"name": "session", "ok": self.ready, "detail": "ready" if self.ready else self.detail[:80]},
            {"name": "login", "ok": self.login_ok, "detail": "result 0" if self.login_ok else self.detail[:80]},
            {"name": "clock", "ok": self.clock_ok, "detail": "set" if self.clock_ok else "waiting"},
            {
                "name": "video",
                "ok": video == "on",
                "detail": f"{self.video_bytes} bytes" if self.video_bytes else video,
            },
        ]
        self._put_outbox(
            (
                "/api/bridge/status",
                {
                    "phase": self.phase,
                    "attempt": self.attempt,
                    "detail": self.detail,
                    "video": video,
                    "checks": checks,
                    "needsPassword": needs_password,
                },
            )
        )

    def _put_outbox(self, item: tuple[str, dict]) -> None:
        try:
            self.outbox.put_nowait(item)
        except queue.Full:
            try:
                self.outbox.get_nowait()
            except queue.Empty:
                pass

    def _poll_loop(self) -> None:
        while not self.stop.is_set():
            try:
                payload = self._request("GET", "/api/bridge/poll?wait=8", None)
            except urllib.error.HTTPError as exc:
                if exc.code == 401:
                    log("bridge token was rejected")
                    self.stop.set()
                    return
                time.sleep(2 if exc.code == 409 else 1.5)
                continue
            except Exception:
                time.sleep(2)
                continue
            if not isinstance(payload, dict):
                time.sleep(1)
                continue
            commands = payload.get("commands")
            with self.lock:
                self.video_desired = payload.get("video") is True
                if payload.get("stream") in (2, 3):
                    self.stream = payload["stream"]
            if not isinstance(commands, list):
                continue
            for command in commands:
                if not isinstance(command, dict):
                    continue
                op = command.get("op")
                if op == "configure":
                    self._configure(command)
                elif op == "reconnect":
                    with self.lock:
                        self.force_reconnect = True
                    self._enqueue_result(command.get("id"), True, "reconnecting", None)
                elif op == "call":
                    with self.lock:
                        if len(self.commands) >= 8:
                            busy = True
                        else:
                            self.commands.append(command)
                            busy = False
                    if busy:
                        self._enqueue_result(command.get("id"), False, "bridge is busy", None)

    def _report_loop(self) -> None:
        while not self.stop.is_set():
            try:
                path, payload = self.outbox.get(timeout=0.5)
            except queue.Empty:
                continue
            for _ in range(3):
                try:
                    self._request("POST", path, payload)
                    break
                except urllib.error.HTTPError as exc:
                    if exc.code == 401:
                        log("bridge token was rejected")
                        self.stop.set()
                        return
                    time.sleep(0.4)
                except Exception:
                    time.sleep(0.4)

    def _request(self, method: str, path: str, payload):
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            self.base + path,
            data=data,
            method=method,
            headers={
                "Authorization": "Bearer " + self.token,
                "Accept": "application/json",
                **({} if data is None else {"Content-Type": "application/json"}),
            },
        )
        timeout = 12 if method == "GET" else 8
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = res.read()
        if not raw:
            return {}
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}


def main() -> int:
    if "--selftest" in sys.argv:
        selftest()
        return 0
    selftest()
    bridge = Bridge()
    return bridge.run()


if __name__ == "__main__":
    sys.exit(main())
