# Remote Operator Console — Technical Design

Status: draft for build  
Scope: USB HID input, camera display capture, operator web UI  
Hardware freeze: Pi 4, ESP32-S3, Camera Module 3. Software and on-wire formats can change.  
Optimization bar: HID and media stay on separate sockets. The **middleman server** is the piece we tune hard (worldwide hairpin). Edge devices stay simple.

This document describes what we are building, how the pieces connect, and the contracts between them. It is written against the existing HID relay (`HID/`) and ESP32 USB keyboard firmware (`web-hid/`). Camera, mouse, UDP video, photo, split view, and paced paste are new.

---

## 1. Problem

We need to drive a machine that we do not (and must not) install software on.

The operator sits at a browser. The target is any laptop or PC. A USB dongle plugged into the target appears as a local keyboard and mouse. A camera pointed at that machine’s monitor is the only way to see what happened.

Constraints:

- No agent on the target OS.
- Input must feel instant and must not stick keys.
- Video is for the operator’s eyes; it must not stall input.
- Paste must not dump a whole clipboard in one HID burst.
- Secrets stay out of git and out of logs. Key identities are never logged.

Non-goals for this generation:

- Perfect glass-to-glass video under 100 ms.
- Gaming-grade 1000 Hz mice.
- Stereoscopic or multi-camera.
- Running the camera encode on the ESP32.
- Public unauthenticated streaming.

---

## 2. Nodes

Four machines. Do not collapse HID and video onto one socket or one microcontroller.

```
[Operator browser]
        |  HTTPS + WSS (session cookie)
        v
[Relay  — Node, existing HID/ server]
        |                         |
        | WSS /ws/device          | HTTPS /media/*  (session)
        | (device token)          |
        v                         v
[HID dongle, ESP32-S3]     [Capture node, Pi 4]
   USB HID gadget              CSI camera + encode
        |                         |
        v                         v
[Target PC, USB host]      [Target monitor, optical]
```

| Node | Role | Must not do |
|---|---|---|
| Target PC | USB host only | Run our code |
| HID dongle | Enumerate keyboard + mouse, apply binary frames | Encode video, store WiFi passwords in source |
| Capture node | CSI preview, H.264/UDP ingest, still JPEG | Interpret keystrokes |
| Relay | Auth, HID fan-in, media reverse-proxy or redirect | Log key bodies or paste text |

The operator UI is served by the control plane. HID bytes and media packets both **must** pass a public middleman (devices sit on home/campus NAT; operators are anywhere). That server is a forwarder, not an interpreter and not a transcoder. See §5.

---

## 2.1 Locked tech stack

One choice per layer. Do not add a framework unless that layer’s section names it.

### Hardware

| Role | Stack |
|---|---|
| Target | Any USB-host OS (Windows / Linux / macOS). No app of ours. |
| HID dongle | Seeed XIAO ESP32-S3 |
| Capture | Raspberry Pi 4 (64-bit) + Camera Module 3 (IMX708) |
| Operator | Chromium (Keyboard Lock + WebRTC). Firefox is best-effort. |

### HID firmware (`web-hid/`)

| Piece | Stack |
|---|---|
| SDK | PlatformIO, `espressif32`, Arduino USB device |
| USB | `USB.h` + `USBHIDKeyboard` + `USBHIDMouse`, CDC off |
| Link | Wi‑Fi STA, `WiFi.setSleep(false)` |
| To VPS | `WebSocketsClient` TLS (`wss`) to `/ws/device?token=` |
| On-wire | Binary frames §4.2 (12-byte live) |

Same bytes if firmware later moves to ESP-IDF TinyUSB. Do not change the contract to do that port.

### Capture node (Pi 4)

| Piece | Stack |
|---|---|
| OS | Raspberry Pi OS Lite 64-bit |
| Camera | `rpicam-apps` / libcamera, Module 3 tuning |
| Live encode | `rpicam-vid` H.264, 1280×720@30 |
| Publish | WHIP or RTP **to MediaMTX on the VPS** (not MPEG-TS to the public host) |
| Still | `rpicam-still` / `rpicam-jpeg` behind a local token HTTP (Python 3 stdlib or a 50-line script) |
| Secrets | env file, not git |

### VPS (middleman)

| Process | Stack | Listens (internal) |
|---|---|---|
| TLS edge | Caddy 2 | 443 → reverse proxy |
| Control | Node 20, Express 4, Helmet, cookie-session, `HID/` | 127.0.0.1:8080 |
| HID forward | Go 1.23, `gorilla/websocket` or `coder/websocket`, `hidfwd/` | 127.0.0.1:8081 |
| Media | MediaMTX, **no transcode** | WHIP in, WHEP/WebRTC out |

Caddy routes:

| Public path | Backend |
|---|---|
| `/` `/api/*` `/css/` `/js/` `/ws/ctrl` | Node control |
| `/ws/hid` `/ws/device` | hidfwd |
| `/webrtc/` WHEP | MediaMTX |

No Redis, no DB. One device, env secrets (`GATE_PASSWORD`, `SESSION_SECRET`, `DEVICE_TOKEN`, `CAPTURE_TOKEN`).

### Operator UI

| Piece | Stack |
|---|---|
| Pages | Static HTML/CSS/JS in `HID/src/public` (no React/Vite) |
| Live HID | Binary `WebSocket` `/ws/hid`, keymap in `hid-keymap.js` |
| Paste / login | `fetch` + JSON `/api/*` and `/ws/ctrl` |
| Video | `<video>` + WebRTC WHEP |
| Mouse | Pointer Lock, 16-bit relative deltas |

### Explicitly not in the stack

Python on the ESP32. Video through Node. MJPEG or MPEG-TS on the public host. A database. React. JSON on the live HID socket.

---

## 3. Operator UI

Three views, one login, one HID socket. Switch with a view toggle. HID live mode is available in the two camera views. Paced paste is its own view so it cannot fight live keys.

### 3.1 View A — Focus (full bleed camera)

Use when the operator is driving the target: clicking, typing, watching the real screen.

- Camera fills the viewport. Black letterbox if aspect does not match.
- Click on the video to focus that pane; then keydown/keyup go to HID, not to the browser chrome.
- Pointer events on the video map to mouse HID (see §5.3).
- Top bar (auto-hide after 2 s, show on mouse-to-edge): connection badges, Stop live, Snapshot, view switch.
- Snapshot button: authenticated `POST /api/photo`. Does not pause HID.
- Keyboard Lock when live (already in `app.js`). Stop with the on-screen button, not Escape (Escape is a target key).

### 3.2 View B — Split (camera | scratch)

Use when the operator wants a local buffer: compose, then send, or type live while glancing at notes.

- CSS grid `1fr 1fr` (stack to column under 900 px width).
- Left: same video + mouse hit-layer as View A.
- Right: local editor (textarea / CodeMirror-class). Text here is **not** sent until the operator hits Send paced or enables Live keys with focus on the video.
- Focus rule: if the scratch editor is focused, keys stay local. If the video is focused (or Live is on and pointer is over the video), keys go to HID.
- A thin status strip: ESP32, WS, camera, live/idle.

### 3.3 View C — Paced paste

Use for copy-paste of a block that should look like typing, not a USB flood.

- Large paste area (raise cap from 2000 to 8000 chars; still chunked).
- Controls: WPM, jitter percent, stop/pause, charset mode (see §7).
- Progress: chars sent / remaining, current delay, pause button.
- Disabled while View A/B live keys are on. Starting paste stops live keys and `releaseAll`.

### 3.4 Chrome (all views)

- Login gate unchanged: `POST /api/login`, HttpOnly cookie, 5 tries / 15 min.
- Badges: ESP32 connected, UI socket, camera streaming, live/paste state.
- Logout always `releaseAll` then clear cookie (already on UI socket close).

Visual bar: dense, dark, large video, small controls. No marketing copy in the console.

---

## 4. HID device (ESP32-S3)

Board: Seeed XIAO ESP32-S3 (existing `web-hid`). USB device mode, CDC off (`ARDUINO_USB_CDC_ON_BOOT=0`) so the host sees HID, not a serial port.

### 4.1 Descriptors

Composite USB device, two HID interfaces:

| Interface | Report | Notes |
|---|---|---|
| 0 | Keyboard, boot protocol, usage page 0x07 | Existing `USBHIDKeyboard` |
| 1 | Mouse, relative, 3 buttons + wheel | New `USBHIDMouse` (or TinyUSB HID if we move to ESP-IDF later) |

One USB plug. The target OS loads stock drivers. No custom INF.

ESP-IDF TinyUSB is a later firmware port. Keep the **on-wire HID frames** stable so the relay does not care which firmware stack is flashing.

### 4.2 Device ← middleman binary contract

Live input is binary WebSocket frames **end to end**: browser maps `KeyboardEvent.code` locally, then ships the same bytes the ESP32 consumes. The server does not parse JSON and does not run the keymap on the hot path.

Text JSON is only for `device_ready` from the device and for paste job control (slow path).

Little-endian. Fixed header 4 bytes, then payload.

```
offset 0  op      u8
offset 1  flags   u8     bit0 = has_seq (always 1 for live)
offset 2  seq     u16    wrapping counter, drop-detect only
```

| op | Payload | Meaning |
|---|---|---|
| 1 | usage u8 | Keyboard down |
| 2 | usage u8 | Keyboard up |
| 3 | none | `releaseAll` keyboard + mouse buttons |
| 4 | buttons u8, dx i16, dy i16, wheel i8 | Mouse relative + buttons + wheel in one report |
| 10 | len u8, utf8[len] | Paced paste chunk (slow path, ≤32 bytes) |

Keyboard usage allow-list: modifiers `0xE0–0xE7`, keys `1–0xA4`. Drop anything else.

Mouse: bit0 left, bit1 right, bit2 middle. **16-bit** `dx`/`dy` so a fast flick is one USB report, not a split storm. Wheel is i8.

Max live frame: 4 + 8 = **12 bytes**. Server max payload for live ops: 32 bytes. Drop larger live frames.

On `WStype_DISCONNECTED` or `WStype_ERROR`: `Keyboard.releaseAll()` and mouse button release. Same on op 3.

### 4.3 Loop

`webSocket.loop()` with **no** `delay(10)`. A short `yield` is enough. `WiFi.setSleep(false)` stays.

Reconnect interval 4 s is fine. Credentials: NVS or gitignored header, never committed source.

### 4.4 Reliability

- One device socket at a time (relay already replaces the previous ESP32).
- If a frame is malformed, drop it; do not disconnect (avoids flap).
- Do not apply text `Keyboard.print` during live binary mode except paced paste (§7), which is a distinct op or a text opcode used only while paste is armed.

Paced paste from relay to device: UTF-8 text chunks, max 32 bytes per WS message, or per-character HID if “physical keys” mode is on. Default is `Keyboard.print` of one rune/chunk so layout follows the **target** OS.

---

## 5. Middleman (worldwide)

Hardware cannot be next to the operator. The public server is mandatory: ESP32 and Pi sit behind NAT; the browser is on another network. TLS terminates once. After auth, the server only **forwards**.

World RTT (operator → VPS → home) is the latency floor. You cannot code that away. What you **can** do is make the VPS add near-zero extra work: no JSON parse, no keymap, no H.264 transcode, no video through the HID process, no queue of mouse moves.

### 5.0 Process split

```
                 TLS (Caddy / nginx)
                         |
        +----------------+----------------+
        |                                 |
   control plane                    data plane
   (Node, existing HID/)            (two binaries)
   login, static UI,                hidfwd     MediaMTX
   paste JSON, photo API            /ws/hid    WHIP/WHEP
                                    /ws/device RTP only
```

| Process | Language | Hot path | Must not |
|---|---|---|---|
| Control | Node, keep `HID/` | HTTP, paste job ~7 Hz | Touch live HID bytes or RTP |
| `hidfwd` | Go (small) | Binary WS copy, allow-list, rate limit | JSON, keymap, disk, video |
| MediaMTX | existing | RTP/WebRTC forward, no transcode | Decode for the operator |

Node `ws` can copy 12-byte frames, but the same process already runs Express, Helmet, paste timers, and photo. A dedicated `hidfwd` keeps the HID event loop empty. That is “optimized to the core” for this product, not a rewrite of USB or libcamera.

`hidfwd` checks, then `write` the same buffer to the device socket:

- Session or device token (handshake only).
- `op` in {1,2,3,4,10}.
- Size exact for that op.
- Rate: 250 keyboard ops/s, 250 mouse ops/s (16-bit deltas, no split).
- If device socket is down: drop, send one UI status binary, do not buffer.

Keymap stays in the **browser** (`hid-keymap.js`). Layout is still the target OS.

### 5.1 Control plane (keep)

- Helmet CSP, origin check, session cookie, login rate limit.
- `/ws/device?token=` with `DEVICE_TOKEN` (served by `hidfwd`).
- Legacy `/` off in production.
- Paste start/pause/cancel JSON on control HTTP or a **second** UI socket `/ws/ctrl` so live `/ws/hid` stays binary-only.
- `releaseAll` (op 3) on UI close.

### 5.2 Live path

Browser `/ws/hid` (cookie) → `hidfwd` → `/ws/device` (token). Same binary layout as §4.2.

Mouse: one op-4 frame per pointer event; 16-bit `dx`/`dy`; no server-side split.

### 5.3 Clicking on the video (coordinate policy)

The camera is an analog view of a monitor. Pixel (x,y) in the `<video>` element is **not** a HID absolute desktop coordinate unless we calibrate.

v1 (ship this): **relative mouse** only.

- Pointer lock on the video when Live + Focus/Split video-focused.
- MovementX/Y → dx/dy. Click buttons → button bits.
- Operator “aims” like a high-latency VNC with a relative mouse. Good enough; no calibration wizard.

v2 (optional later): absolute mapping.

- Operator clicks four corners of the visible screen in the video.
- Store affine map video-px → assumed 1920×1080 (or configured target res).
- Requires HID absolute/digitizer reports, which some BIOS/login screens ignore. Keep relative as default.

Do not block v1 on calibration.

### 5.4 Instant vs reliable

Instant: binary frames, no per-key ACK. Loss is rare on WSS over a stable link; OS key repeat is suppressed in the browser (`event.repeat` ignored). Stuck keys: `releaseAll` on blur, hidden tab, socket close, Stop.

Reliable enough: if the device socket is down, the UI shows Disconnected and does not queue a storm of keys. Drop, do not buffer more than ~50 mouse moves.

Paste is the opposite: explicit queue, pause, cancel (§7).

---

## 6. Camera and video

Hardware freeze: Raspberry Pi 4 + Camera Module 3 (IMX708, autofocus). Aimed at the target monitor. Ethernet if possible. HDMI not required in production.

### 6.1 Capture process

On the Pi, after `rpicam-hello --list-cameras` works:

- Preview / stream: `rpicam-vid` H.264.
- Photo: `rpicam-still` or `rpicam-jpeg` to a temp file, then HTTP upload/return.

Default stream: **1280×720 @ 30**. Not 1080p until this is boringly stable. Not 4K.

The Pi does not speak HID. It does not open `/ws/device`.

### 6.2 How video reaches the browser

Browsers cannot play raw UDP. UDP is an **ingest** hop, not the operator hop.

Worldwide, the Pi cannot UDP to the operator. Both publish to the VPS.

```
Camera Module 3 → rpicam-vid H.264
       → WHIP or RTP to MediaMTX on the VPS
       → WHEP/WebRTC to the browser
```

Prefer **WHIP from the Pi** (or MediaMTX on the Pi publishing RTSP/WHIP to the VPS) over MPEG-TS. TS mux is extra delay for no gain once the hop is already a public server.

| Hop | Protocol | Server work |
|---|---|---|
| Pi → VPS | WHIP / RTP H.264 | Forward packets |
| VPS → browser | WebRTC (UDP/DTLS) | Forward packets |
| Debug LAN only | HTTP MJPEG | Do not enable on the public host |

**No transcode on the VPS.** Pi 4 already encodes 720p30. Re-encoding on the server burns CPU and adds 100 ms+ for nothing.

MediaMTX is the media core. Node never sees NAL units. Auth: WHEP behind Caddy with the same session cookie, or a short-lived WHEP token minted by the control plane.

### 6.3 Relay media routes (session required)

| Method | Path | Action |
|---|---|---|
| GET | `/media/webrtc` | Page or WHIP/WHEP signaling proxied to sidecar |
| POST | `/api/photo` | Relay → Pi `POST /still` with a service token; return JPEG |
| GET | `/api/camera-status` | `{ streaming, lastError }` |

The browser never gets the Pi’s raw IP. The relay holds `CAPTURE_URL` and `CAPTURE_TOKEN` in env.

Pi still endpoint: loopback or LAN bind, token header, rate limit 1 photo / 2 s (still capture blocks the sensor briefly; HID must keep running on the ESP32, which it will, because it is a different node).

### 6.4 Photo button

Operator hits Snapshot.

1. UI `POST /api/photo` with credentials.
2. Relay calls Pi, waits ≤ 5 s.
3. Response: `image/jpeg` download or inline blob in a lightbox. Filename `capture-YYYYMMDD-HHMMSS.jpg`.
4. Failure: toast, HID unchanged.

Do not freeze the H.264 pipeline longer than one still. If `rpicam-still` fights the vid process, run still on a second camera command with `--immediate` and accept a short stream glitch, or switch to a snapshot from the encoder sidecar if MediaMTX can grab a keyframe (nicer, later).

### 6.5 Video quality vs HID

Never mux JPEG or NAL units onto `/ws/ui` or `/ws/device`. If the camera dies, the video pane shows a reconnecting state; live keys stay up.

Budgets (not SLAs, just build targets):

| Path | Target |
|---|---|
| hidfwd copy | **< 1 ms** in-process after the socket read |
| HID worldwide | **1× RTT + 5–15 ms** stack (Wi‑Fi + USB). Typical 80–200 ms intercontinental |
| WebRTC 720p30, no transcode | **1× path RTT + 150–300 ms** encode/camera |
| MJPEG on public VPS | Forbidden |
| Photo | 1–3 s JPEG |

---

## 7. Paced paste

Problem: `send` today ships the whole string in one WS text message; firmware `Keyboard.print`s it as fast as USB allows. Hosts drop or scramble, and it looks unlike a human.

### 7.1 Where pacing lives

**Relay**, not the ESP32 and not only the browser.

The browser uploads the job `{ text, wpm, jitterPct }` on **control** HTTP or `/ws/ctrl`. The Node control plane owns the queue and timer; it emits op-10 binary chunks **into hidfwd** (localhost). Live `/ws/hid` stays clear. If the operator closes the tab, the job **cancels** and `releaseAll` runs. If we paced only in the browser, a refresh would leave the device mid-type with no cancel.

### 7.2 Parameters

| Param | Default | Range | Meaning |
|---|---|---|---|
| WPM | 80 | 20–180 | Words per minute, 5 chars = 1 word (standard) |
| Jitter | 25% | 0–50% | Uniform random scale of the base interval |
| Chunk | 1 | 1–8 | Chars per HID print tick (1 = most natural) |
| Mode | `print` | `print` \| `hid` | `print` uses UTF-8 via `Keyboard.print`; `hid` only ASCII mapped through keymap (US physical) |

Base interval:

```
charsPerSec = (wpm * 5) / 60
baseMs = 1000 / charsPerSec
delayMs = baseMs * (1 + U(-jitter, +jitter))
```

Example: 80 WPM → 6.67 chars/s → ~150 ms average. With 25% jitter, ~112–188 ms.

Also inject extra delay on newline (2×) and on `.!?` (1.5×) so editors and terminals keep up. These multipliers are constants, not a research project.

### 7.3 Protocol

Browser → relay (UI socket):

```json
{ "type": "paste_start", "text": "...", "wpm": 80, "jitterPct": 25, "chunk": 1, "mode": "print" }
{ "type": "paste_pause" }
{ "type": "paste_resume" }
{ "type": "paste_cancel" }
```

Relay → device: binary op 3 before start; then either 2-byte HID for `hid` mode or short text frames for `print` mode (length prefix or one WS text message ≤ 32 bytes).

Relay → UI:

```json
{ "type": "paste_progress", "sent": 40, "total": 400, "etaMs": 54000 }
{ "type": "paste_done" }
{ "type": "paste_error", "message": "Device not connected" }
```

Caps: 8000 UTF-8 chars per job. One job at a time globally (single device). Login rate limit unchanged; paste jobs also require session.

### 7.4 Safety

- Do not log `text`. Log `total` and `sent` counts only (already the style for relay).
- Pause on device disconnect; do not continue after reconnect without an explicit Resume (reconnect might be a different host).
- Reject control characters except `\n` `\t` in `print` mode.

---

## 8. Security

Production rules that apply from day one of new surfaces.

**Auth**

- UI: existing gate password (≥16), session secret (≥32), HttpOnly, SameSite=strict, Secure in production.
- Device: `DEVICE_TOKEN` on `/ws/device`. Disable legacy `/` on any host that is not a desk LAN.
- Pi: `CAPTURE_TOKEN`, not the user password. Relay is the only caller.

**Web**

- CSP stays default-src self. WebRTC needs `connect-src` to the same host (WHEP on the relay domain).
- Origin check on UI WebSocket stays.
- Photo and media routes use `requireSession`.
- Do not put camera on port 8080 unauthenticated.

**HID**

- Usage allow-list. No media keys, no power.
- No key names in logs.
- `releaseAll` on every disconnect path.

**Firmware**

- WiFi and tokens from NVS or a local `secrets.h` that is gitignored.
- Rotate any token that ever sat in `main.cpp`.

**Threat note**

This is a hardware key injector plus a camera on a screen. Anyone with the gate password types on the target. Treat the password like a physical key. LAN or VPN first; public deploy only with TLS, device token, and no legacy WS.

---

## 9. What we already have vs what we add

| Piece | Today | Next |
|---|---|---|
| Login, CSP, UI WS | Yes | Keep |
| Live keys, keymap, 250/s | Yes, JSON on server | Move keymap to browser; binary UI→device |
| Binary key frames to ESP32 | Yes, 2-byte | Header + 16-bit mouse; hidfwd copy |
| Text dump `send` | Yes | Keep as “dump” debug; paced paste is the product path |
| USB keyboard | Yes | Add mouse interface |
| `delay(10)` in firmware | Yes | Remove |
| Camera | Not in this repo | Pi + sidecar |
| Focus / split / paste views | Single card UI | Three views |
| Photo | No | `/api/photo` |

---

## 10. Build sequence

Do not start UDP or paced jitter until the row above it works on a desk.

1. **Firmware hygiene** — secrets out of git, `delay(10)` gone, `DEVICE_TOKEN` path only.
2. **UI shell** — three views, no camera (placeholder pane). Live keys work in Focus/Split; scratch editor is local.
3. **Binary UI path** — keymap in the browser; Node or hidfwd copies frames; 16-bit mouse.
4. **hidfwd** — extract live sockets from Express; rate limit + allow-list only.
5. **Paced paste** — control plane queue; op-10 into hidfwd.
6. **Camera detect** — Module 3 `rpicam-hello --list-cameras`.
7. **MediaMTX on the VPS** — Pi WHIP in, browser WHEP out, no transcode; Snapshot via control API.
8. **Polish** — auto-hide chrome, reconnect copy, photo lightbox.

Each step is shippable. Video is not a gate for HID.

---

## 11. Implementation notes (enough to start)

**Repo layout (logical)**

```
HID/                 control plane (login, UI, paste, photo)
hidfwd/              (new) binary WS forwarder
web-hid/             ESP32 firmware
capture/             (new) Pi WHIP + still
docs/TECH_DESIGN.md  this file
```

**Env additions (control + hidfwd)**

```
DEVICE_TOKEN=
CAPTURE_TOKEN=
HIDFWD_LISTEN=127.0.0.1:8081
MEDIAMTX_WHEP=http://127.0.0.1:8889
```

**Pi publish (worldwide)**

Camera Module 3, 1280×720 @ 30, H.264, WHIP (or RTP) to MediaMTX on the VPS. Do not send MPEG-TS to the public host. Still JPEG via a local token HTTP on the Pi, called only from the control plane.

**UI focus manager**

Single `inputTarget = 'none' | 'hid' | 'scratch'`. Live button sets `hid` and pointer-locks the video. Clicking the scratch pane sets `scratch` and unlocks. Paste view forces `none` for live keys.

**Failure matrix**

| Failure | HID | Video | Paste |
|---|---|---|---|
| ESP32 WiFi drop | badge + releaseAll | unchanged | pause |
| Pi camera unplug | unchanged | reconnect overlay | unchanged |
| Relay restart | both reconnect | both reconnect | cancel |
| Operator tab hidden | releaseAll | video may pause | pause |

---

## 12. Acceptance (desk test)

HID

- Second PC with the dongle types when Focus live is on; the operator PC does not type into itself.
- Unplug WS: no stuck modifiers.
- Relative mouse moves a cursor on the target; left click works.

Paste

- 400 character lorem at 80 WPM / 25% jitter finishes without missing glyphs in Notepad.
- Pause/cancel stop within one chunk.
- Device unplug mid-paste does not resume after replug until Resume.

Video

- Focus view shows the monitor; Snapshot downloads a JPEG.
- Killing the Pi stream does not stop live keys.
- Split view: typing in scratch does not hit the target; clicking the video and going live does.

Security

- Unauthenticated `/api/photo` and `/media/*` return 401.
- Device without token cannot bind `/ws/device`.
- Logs show counts, not paste bodies or key names.

---

## 13. Decision log

| Decision | Choice | Why |
|---|---|---|
| Hardware | Pi 4, ESP32-S3, Cam Module 3 | Frozen |
| HID vs media | Separate sockets and processes | Video must not stall keys |
| Worldwide | Public middleman | NAT; operator anywhere |
| Server core | hidfwd copy + MediaMTX forward | No JSON, no transcode on the hot path |
| Live encoding | Browser keymap, 12-byte frames | Server does not interpret keys |
| Mouse | Relative, 16-bit dx/dy | One report per flick; no 8-bit split |
| Video ingest | WHIP/RTP to VPS, WebRTC out | Browsers have no raw UDP; Pi encodes H.264 |
| Paste | Node timer → op 10 | Slow path; must not share `/ws/hid` |
