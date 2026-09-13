# Desk test gates (Steps 1–4)

Run these in order. Stop if a gate fails.

## Gate 0 — Server secrets and health

```bash
cd HID
cp .env.example .env   # if needed
# GATE_PASSWORD ≥16, SESSION_SECRET ≥32, DEVICE_TOKEN ≥16
npm install
npm run build
npm start
```

In another terminal:

```bash
curl -s http://127.0.0.1:8080/healthz
# → {"ok":true}

# Missing secrets: temporarily empty DEVICE_TOKEN and confirm process exits on boot.

curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/app
# → 302 (redirect to login)

curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8080/api/paste \
  -H 'Content-Type: application/json' -d '{"text":"x"}'
# → 401
```

Unauthenticated WebSocket upgrades must return **401**:

- `GET /ws/device` without `?token=`
- `GET /ws/hid` without session cookie

## Gate 1 — Firmware hygiene

```bash
cd web-hid
cp include/secrets.h.example include/secrets.h
# Set WIFI_*, WS_HOST=<operator LAN IP>, WS_PORT=8080, WS_USE_SSL=false
# DEVICE_TOKEN must match HID/.env
pio run -t upload
```

Plug the XIAO into the **target** PC (not the operator PC). Confirm Wi-Fi joins and the operator UI device badge shows **Connected**.

Unplug Wi-Fi / kill power: badge → **Disconnected**.

## Gate 2 — Live keys on a second PC

1. Focus Notepad (or any editor) on the **target**.
2. On the operator: open `/app`, Focus view, click the camera placeholder, **Start live**.
3. Type `abc`, Shift, Enter, Backspace.
4. **Stop**. Close the operator tab mid-key.

Pass when:

- Characters appear only on the target.
- Stop / tab close leaves no stuck Ctrl/Shift/Alt.
- Device badge tracks connect/disconnect.

## Gate 3 — Dump paste

1. Stop live.
2. Paste view: enter ~20 characters, **Send**.
3. Check server log: a character **count** only (no paste body).

Pass when text appears on the target and live keys still work afterward.

## Gate 4 — Three-view focus isolation

1. Split view: type in the scratch textarea while live is off → nothing on target.
2. Start live, click the video placeholder, type → target receives keys.
3. Click scratch while live → keys stay local (scratch); pointer unlocks.
4. Switch Focus → Paste → Focus: each switch releases keys (`releaseAll`).

## Gate 5 — Relative mouse

**Flash firmware with mouse support first** (`USBHIDMouse`, op 4).

1. Target: open a desktop or drawing app so cursor motion is visible.
2. Operator: Focus view, **Start live** (pointer should lock).
3. Move the mouse → target cursor moves.
4. Left click; right click; scroll wheel.
5. Esc (exit pointer lock) then Stop. Mid-drag: close the tab or switch to Paste.

Pass when:

- Cursor moves on the target (relative, not absolute).
- Left click works; no stuck mouse buttons after Stop / Esc / tab close.
- Keys still work in the same live session.
- Scratch focus does not move the target mouse.

## Gate 6 — Same-PC Self-test

Plug the ESP32 into the **operator** PC (the machine running the browser), not a second target.

1. Open `/app` → **Self-test** tab.
2. Click the hit pad, enable **Arm**.
3. Run **Keyboard RTT** — table shows down/up p50 and loss%.
4. Keep the hit pad focused; run **Click RTT**.
5. Run **Burst 100/s** and **Burst 250/s** — note loss%.
6. Run **Square smoke** — wall-clock completes.
7. **Abort** mid-run once; confirm status aborts and keys/buttons release.
8. **Copy JSON** — clipboard has `when`, `pathHint`, `tests`.
9. Leave Self-test (switch to Focus) — inject stops; no stuck modifiers.

Pass when:

- Keyboard down p50 is finite (not all misses) with the dongle on this PC.
- Click RTT records hits while the pad is focused.
- Received HID events never re-inject (no feedback loop / stuck repeating keys).
- No extra auth beyond the existing gate login.

## Gate 7 — Stream-test loopback (glass-to-glass)

Requires MediaMTX with path **`desk`** deployed (HTTPS domain + UDP ICE), and a camera on the operator PC. Uses `VITE_MEDIA_BASE_URL` (default `https://mediarelay.sahilpatel.online`). Path `desk` is separate from Pi `cam`.

**Security note:** MediaMTX publish/read on `desk` is open until auth is tightened — anyone who can reach `/desk/whip` can publish.

1. Open `/app` → **Stream-test** tab.
2. Enable **Arm**.
3. **Start loopback** — allow camera; local canvas shows QR overlay; received pane shows the WHEP stream (not “stream not found”).
4. **Run latency sample** — table shows glass-to-glass p50/p95/p99 and decode hit count.
5. **Snapshot getStats** — RTT / jitter / FPS / resolution rows appear.
6. **Copy JSON** — clipboard has `when`, `mediaBase`, `tests`, `peerStats`, `logTail`.
7. **Stop** or leave the tab — camera and WHIP/WHEP sessions tear down.

Pass when:

- Remote video plays with a visible QR in the corner.
- Latency sample returns finite p50 (not all decode misses).
- Leaving Stream-test releases the camera (browser indicator clears).

### Gate 7 troubleshooting — `Failed to fetch` / no Network hit for `/desk/whip`

If the log shows WHIP POST then instant **Failed to fetch**, and DevTools finds **no** `desk/whip` request, check the **Console** for Content-Security-Policy refusals. The HID app must allow `connect-src` to the MediaMTX origin and STUN (see `docs/STREAMTEST_NOTES.md`). Restart HID after CSP changes. Separate from MediaMTX TLS/502 bring-up.

## Binary live frame (reference)

Little-endian header: `op u8`, `flags u8` (bit0 = seq), `seq u16`.

| op | Size | Payload |
|---|---|---|
| 1 / 2 | 5 | `usage` u8 |
| 3 | 4 | releaseAll (keyboard + mouse) |
| 4 | 10 | `buttons` u8, `dx` i16, `dy` i16, `wheel` i8 |

## Not in these gates

Paced WPM, Pi camera publisher (use Gate 7 desk loopback instead), Go `hidfwd`, MediaMTX auth hardening / session-proxied WHEP.
