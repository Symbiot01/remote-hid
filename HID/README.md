# Operator console

Password-gated operator console. The browser talks only to this server. LookCam video is published by the bridge, transcoded here, and played through session-gated WebRTC. HID keys are proxied to a separate relay. The device token stays on that relay.

## Local run

```bash
cp .env.example .env
# Set GATE_PASSWORD (≥16) and SESSION_SECRET (≥32)
npm install
npm run build          # Vite React → src/public
npm start              # http://127.0.0.1:8080
```

Dev (API on :8080, Vite on :5173 with proxy):

```bash
npm install
npm --prefix web install
npm run dev
```

## Coolify

This directory is the Docker build context. The image builds `web/`, serves it from `src/public`, and listens on `PORT` (image default `3000`) and `HOST` `0.0.0.0`. Set `TRUST_PROXY=1` behind the Coolify proxy. `GET /healthz` is the health check. The runtime image includes ffmpeg for the camera ingest.

Leave `CAPTURE_TOKEN` empty to refuse the capture agent. Leave `HID_URL` empty until the keyboard relay is listening on another port. Do not put `DEVICE_TOKEN` in this service.

## Environment

| Variable | Required | Notes |
|---|---|---|
| `GATE_PASSWORD` | yes | UI password, min 16 chars |
| `SESSION_SECRET` | yes | Cookie signing, min 32 |
| `PORT` | no | `8080` locally, `3000` in the image |
| `HOST` | no | `127.0.0.1` locally, `0.0.0.0` in the image |
| `TRUST_PROXY` | no | `1` behind a reverse proxy |
| `BRIDGE_TOKEN` | no | Empty refuses LookCam ingest |
| `LOOKCAM_PASSWORD` | no | Delivered only to the bridge |
| `HID_URL` | no | Relay base URL, empty disables HID |
| `HID_GATE_PASSWORD` | with HID_URL | Min 16. Never sent to the browser |
| `CAPTURE_TOKEN` | no | Empty refuses the capture agent |
