# Operator Console

Password-gated React operator console that drives an ESP32-S3 USB HID keyboard/mouse over WebSocket.
Live keys use **binary** frames on `/ws/hid`. Dump paste uses `POST /api/paste`.
The device connects only to `/ws/device?token=…`.

## Local run

```bash
cp .env.example .env
# Set GATE_PASSWORD (≥16), SESSION_SECRET (≥32), DEVICE_TOKEN (≥16)
npm install
npm run build          # Vite React → src/public
npm start              # http://127.0.0.1:8080
```

Dev (API on :8080, Vite on :5173 with proxy):

```bash
npm install
npm run build          # first time so Express has an index if you hit :8080
npm run dev
```

Open the Vite URL `http://127.0.0.1:5173` (or production build on `:8080`), log in, wait for **Connected**, then Start live.

### Firmware (`web-hid`)

1. `cp include/secrets.h.example include/secrets.h` (gitignored).
2. Set Wi-Fi, `WS_HOST`, `WS_PORT`, `WS_USE_SSL`, same `DEVICE_TOKEN`.
3. `pio run -t upload`.

## Environment

| Variable | Required | Notes |
|---|---|---|
| `GATE_PASSWORD` | yes | UI password, min 16 chars |
| `SESSION_SECRET` | yes | Cookie signing, min 32 |
| `DEVICE_TOKEN` | yes | Device WS token, min 16 |
| `PORT` | no | Default `8080` |
| `HOST` | no | Default `0.0.0.0` |
| `NODE_ENV` | no | `development` or `production` |
| `TRUST_PROXY` | no | `1` behind a reverse proxy |

## API / sockets

- `POST /api/login` / `POST /api/logout` / `GET /api/status` / `POST /api/paste`
- `GET /healthz`
- `WS /ws/hid` — binary live HID; cookie + origin check
- `WS /ws/device?token=` — ESP32 only

Frontend source: `web/` (Vite + React + TypeScript). Docker builds the SPA then runs Express.

## Desk tests

See `docs/DESK_TESTS.md`.
