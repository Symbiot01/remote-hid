# Slice E — still vs live SRT (clash and solution)

## Problem: still and stream cannot run together

| Process | Role | Service |
|---------|------|---------|
| `rpicam-vid` → ffmpeg → SRT | Live `/cam` | `whip.service` |
| `rpicam-still` | Snapshot JPEG | `capture-ws.service` → `camera_still.py` |

Libcamera / Unicam allows **one** client. If `whip.service` is running:

```text
rpicam-still … → exit status 255
```

UI may show that error via `photo_err`, or **Capture timed out** if the still hangs / takes longer than HID’s photo deadline.

### Related failures (same era)

1. **Old `capture_ws.py`** still had inline `_capture_jpeg` with only `rpicam-still -n -o` (no whip release, no `--immediate`) — slow (~5 s) and camera-busy.
2. **HID timeout 5 s** too short for stop → still → start (raised to **20 s** in `captureHub.js`).
3. **systemd without `XDG_RUNTIME_DIR`** — `rpicam-still` under the service can hang → timeout even with whip stopped.
4. **`NoNewPrivileges=yes`** on `capture-ws` blocks `sudo -n systemctl` needed to release the camera.
5. **`git pull` blocked** by a local edit to `publish_whip.sh` — stash or discard local stub/SRT edits, then pull; remote already has the real SRT script.

## Solution (implemented in this repo)

```text
photo_req (HID → Pi WS)
  → camera_still.capture_jpeg()
      if whip active: systemctl stop whip.service
      rpicam-still -n --immediate --timeout 1000 --width 1280 --height 720
      systemctl start whip.service   (always in finally)
  → photo_meta + JPEG bytes → HID → UI lightbox
```

| Piece | Purpose |
|-------|---------|
| [`camera_still.py`](../camera_still.py) | Shared still + optional whip stop/start |
| [`scripts/capture_ws.py`](../scripts/capture_ws.py) | Slice E agent (imports `capture_jpeg`) |
| [`sudoers/capture-whip.sudoers`](../sudoers/capture-whip.sudoers) | Passwordless `systemctl` **only** for `whip.service` |
| [`systemd/capture-ws.service.example`](../systemd/capture-ws.service.example) | `XDG_RUNTIME_DIR=/run/user/1000`, **no** `NoNewPrivileges` |
| HID `PHOTO_TIMEOUT_MS = 20000` | Room for stop/still/start |

Tradeoff: live `/cam` **glitches ~1–3 s** per Snapshot. Acceptable for MVP.

Env (Pi `.env`):

```bash
CAPTURE_RELEASE_WHIP=1
WHIP_SERVICE=whip.service
```

## Pi bring-up after pull

If `git pull` fails on `publish_whip.sh`:

```bash
git stash push -m 'local publish_whip' -- scripts/publish_whip.sh
git pull origin main
# Remote SRT script is correct; drop stash unless you had unique edits:
# git stash drop
```

Then:

```bash
sudo cp ~/capture/sudoers/capture-whip.sudoers /etc/sudoers.d/capture-whip
sudo chmod 440 /etc/sudoers.d/capture-whip
sudo visudo -cf /etc/sudoers.d/capture-whip

sudo cp ~/capture/systemd/capture-ws.service.example /etc/systemd/system/capture-ws.service
# Confirm XDG_RUNTIME_DIR=/run/user/$(id -u) if uid ≠ 1000
sudo systemctl daemon-reload
sudo systemctl restart capture-ws.service
sudo systemctl restart whip.service   # if you want live /cam again

journalctl -u capture-ws.service -f
# Snapshot → photo_req / still: … / photo_ok
```

Redeploy HID so the **20 s** photo timeout is live.

## Longer-term (not done)

Shared pipeline so still does not stop SRT (e.g. JPEG from the same encoder / dual-stream app). Until then, brief whip bounce is the supported path.

See also [`SLICE_C_SRT.md`](SLICE_C_SRT.md) (WHIP→SRT, campus UDP 8890 / WARP).
