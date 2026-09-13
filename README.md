# Remote HID

Operator stack: ESP32-S3 USB keyboard/mouse, Raspberry Pi camera publish, and a public WebSocket/MediaMTX relay.

| Directory | Role |
|---|---|
| `HID/` | Relay + operator UI (Node/Express + React). Deploy this to the server. |
| `web-hid/` | ESP32-S3 firmware (PlatformIO). |
| `capture/` | Raspberry Pi still + SRT publish units. |

## Secrets

Do not commit real credentials.

- Server: copy `HID/.env.example` → `HID/.env`
- Firmware: copy `web-hid/include/secrets.h.example` → `web-hid/include/secrets.h`
- Pi: copy `capture/env.example` → `capture/.env` on the device only (`chmod 600`)

`DEVICE_TOKEN` must match on the server and the ESP32. `CAPTURE_TOKEN` must match on the server and the Pi.

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

Pi camera (see `capture/README.md`):

```bash
cd capture
cp env.example .env
```
