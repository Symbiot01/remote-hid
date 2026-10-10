# Remote operator console

| Directory | Role |
|---|---|
| `HID/` | Operator console (Node/Express + React). This is the Coolify deploy. |
| `web-hid/` | ESP32-S3 firmware (PlatformIO). |
| `capture/` | LookCam bridge and the outbound capture agent. |

## Secrets

Do not commit real credentials.

- Server: copy `HID/.env.example` → `HID/.env`
- Firmware: copy `web-hid/include/secrets.h.example` → `web-hid/include/secrets.h`
- Capture: copy `capture/env.example` → `capture/.env` on the device only (`chmod 600`)

`DEVICE_TOKEN` stays on the HID relay and the ESP32. `CAPTURE_TOKEN` and `BRIDGE_TOKEN` stay on this server and the agent or bridge that dials in. The browser never receives them.

## Quick start

Server (see `HID/README.md`):

```bash
cd HID
cp .env.example .env
npm install
npm run build
npm start
```

Firmware (see `web-hid/`):

```bash
cd web-hid
cp include/secrets.h.example include/secrets.h
pio run -t upload
```

Capture (see `capture/README.md`):

```bash
cd capture
cp env.example .env
```
