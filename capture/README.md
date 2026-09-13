# Capture node (Raspberry Pi 4 + Camera Module 3)

Pi-side publisher for the operator console: **H.264 → MediaMTX** (`cam` path, SRT) and **outbound WS photo** to HID `/ws/capture`.  
No HID. No `/ws/device`. Video never shares sockets with the ESP32 path.

| Slice | Goal | Status |
|-------|------|--------|
| **A** | Detect IMX708 + still JPEG | Run on Pi (scripts below) |
| **B** | Local 720p30 H.264 encode | Run on Pi |
| **C** | Publish live video to MediaMTX path `cam` | **SRT ingest** (see `docs/SLICE_C_SRT.md`) |
| **D** | `still_server.py` token HTTP | Optional local debug |
| **E** | Outbound WS photo → HID `POST /api/photo` | `scripts/capture_ws.py` + `camera_still.py` ([clash docs](docs/SLICE_E_STILL.md)) |
| **F** | Focus WHEP live video in UI | HID Focus/Split → `/cam/whep` |

**Still vs stream:** only one libcamera client. Snapshot briefly stops `whip.service`, then restarts it — see [`docs/SLICE_E_STILL.md`](docs/SLICE_E_STILL.md).

**Why not WHIP from Pi yet?** Distro `ffmpeg` failed as a WHIP client (`-f webrtc`); Stream-test on `/desk` already proved VPS 443+8189. We use **SRT → MediaMTX → WHEP** until a real WHIP client is on the Pi. Details: [`docs/SLICE_C_SRT.md`](docs/SLICE_C_SRT.md).

**Slice E (photo):** Pi dials **out** to `wss://webrelay…/ws/capture?token=…` (same idea as ESP32 `/ws/device`). No Tailscale / static Wi‑Fi IP. Same `CAPTURE_TOKEN` on Coolify HID and Pi `.env`.

### What’s next

1. Finish Pi ops: pull latest, sudoers + `capture-ws` unit (`XDG_RUNTIME_DIR`), redeploy HID (20 s timeout), confirm Snapshot + `/cam` both work.
2. **Slice F** — replace Focus “camera placeholder” with WHEP from `https://mediarelay…/cam/whep` (live view while HID keys work).
3. Later: MediaMTX publish auth; optional true WHIP client; still without bouncing SRT.

Defaults: **1280×720 @ 30**. Not 1080 until 720 is stable.

---

## 1. Hardware & OS baseline

1. **Power off** the Pi 4.
2. CAMERA port (between audio and HDMI): lift collar, insert Module 3 ribbon (**silver contacts facing HDMI**), press collar down.
3. Power on, SSH in.
4. Update + camera apps:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y libcamera-apps
# On newer images the binary may be rpicam-*; package still provides the tools.
```

Clone or copy this repo to the Pi, e.g. `~/capture`.

---

## 2. Slice A — Detect & still

```bash
cd ~/capture
./scripts/slice_a_detect.sh
```

Or manually:

```bash
rpicam-hello --list-cameras
# Expect one camera, imx708 (Module 3)

rpicam-still -n -o /tmp/test.jpg
```

**Headless view:**

```bash
cd /tmp && python3 -m http.server 8080
# Browser: http://<PI_IP>:8080/test.jpg  — then Ctrl+C
```

**Pass:** Sensor listed as `imx708`; JPEG looks correct.  
**Fail → stop.** Do not start WHIP or still server.

---

## 3. Slice B — Local H.264 (720p30)

```bash
cd ~/capture
./scripts/slice_b_encode.sh
```

Or:

```bash
rpicam-vid -t 10000 --width 1280 --height 720 --framerate 30 -o /tmp/test.h264
```

Watch for **10 s** with no libcamera buffer errors. Serve/download `/tmp/test.h264` and play in VLC if useful.

**Pass:** Clean 10 s encode. Then proceed to **Slice C**.

---

## 3b. Slice C — SRT live to `/cam`

```bash
cd ~/capture
# .env should include SRT_URL=srt://mediarelay…:8890?streamid=publish:cam&pkt_size=1316
./scripts/publish_whip.sh
# or: sudo systemctl enable --now whip.service  (see systemd/whip.service.example)
```

Open `https://mediarelay.sahilpatel.online/cam/`. Campus Wi‑Fi often blocks UDP 8890 — use WARP/VPN or an unfiltered uplink (see `docs/SLICE_C_SRT.md`).

**Conflict:** while `rpicam-vid` is running, a bare `rpicam-still` fails (camera busy). Slice E (`camera_still.py`) **briefly stops `whip.service`**, captures, then restarts it. Install passwordless sudo for that unit only — see `sudoers/capture-whip.sudoers`. Live `/cam` will glitch for ~1–3 s per Snapshot. Details: [`docs/SLICE_E_STILL.md`](docs/SLICE_E_STILL.md).

---

## 4. Slice E — outbound WS photo

1. On Coolify HID: set `CAPTURE_TOKEN` (same value as Pi). Remove any old `CAPTURE_URL`. Redeploy HID.
2. On Pi:

```bash
cd ~/capture
pip3 install --user -r requirements.txt
cp env.example .env   # edit RELAY_WS_URL + CAPTURE_TOKEN
python3 scripts/capture_ws.py
# Expect: connecting wss://…/ws/capture  then  capture ws connected
```

3. Systemd (optional): copy `systemd/capture-ws.service.example`, adjust paths/user, `systemctl enable --now`.

4. Smoke: log into operator UI → Capture Online → Snapshot → lightbox JPEG.  
   Live `/cam` may drop for ~1–3 s while whip is restarted around the still.

**Pi sudo (required for Snapshot while whip is running):**

```bash
sudo cp ~/capture/sudoers/capture-whip.sudoers /etc/sudoers.d/capture-whip
sudo chmod 440 /etc/sudoers.d/capture-whip
sudo visudo -cf /etc/sudoers.d/capture-whip
# then: sudo systemctl restart capture-ws.service
```

---

## 5. Layout

```text
capture/
  README.md
  env.example
  requirements.txt
  still_server.py          # Slice D optional LAN debug
  scripts/
    slice_a_detect.sh
    slice_b_encode.sh
    publish_whip.sh        # Slice C SRT → MediaMTX /cam
    capture_ws.py          # Slice E outbound WS agent
  systemd/
    still.service.example
    whip.service.example
    capture-ws.service.example
```

Copy `env.example` → `/etc/hid-capture.env` or `~/capture/.env` (gitignored) before C/E.

---

## Security

- `CAPTURE_TOKEN` authenticates Pi → HID `/ws/capture` only. Not the UI gate password. Never log it.
- Still HTTP (`still_server.py`): optional **127.0.0.1** debug only; Slice E does not need it.
- Do not expose still port on `0.0.0.0/0`.
- MediaMTX / SRT: tighten auth before production.
