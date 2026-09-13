# MediaMTX (Coolify)

Video middleman for the operator console: **Pi publishes H.264 (WHIP) → MediaMTX → browser (WHEP)**.

Keep this **separate** from the HID Node app. Never put video on `/ws/hid`.

Config is **copied into the image** via `Dockerfile` (no bind-mount of `mediamtx.yml`). That avoids Coolify creating `mediamtx.yml` as a directory and failing the mount.

## Coolify

1. New resource → **Docker Compose**.
2. Base directory: `deploy/mediamtx` (this folder).
3. Domain e.g. `mediarelay.sahilpatel.online` → container port **8889** (TCP / HTTPS).  
   If you get **HTTP 502** with a valid Let’s Encrypt cert, the proxy cannot reach the container — confirm port **8889** and that the service joins the `coolify` network (see `docker-compose.yml`).
4. Env (required for WebRTC ICE):

   ```
   MTX_WEBRTCADDITIONALHOSTS=mediarelay.sahilpatel.online,34.47.241.10
   ```

5. VPS / GCP firewall: **443/tcp**, **8189/udp** (WebRTC), **8890/udp** (SRT Pi ingest, rule `allow-testin-srt`).  
   Do not expose **8554** publicly unless you need RTSP debug.

### If a previous deploy failed on the yml mount

SSH to the server and remove the bad path if it is a directory:

```bash
sudo rm -rf /data/coolify/applications/<resource-uuid>/mediamtx.yml
```

Then redeploy.

## URLs

### Path `cam` (Pi / production camera)

| Role | URL |
|---|---|
| Built-in test page | `https://mediarelay…/cam` |
| Pi / ffmpeg publish (SRT) | `srt://mediarelay…:8890?streamid=publish:cam&pkt_size=1316` |
| Pi WHIP (not used yet) | `https://mediarelay…/cam/whip` |
| Browser play (WHEP) | `https://mediarelay…/cam/whep` |
| RTSP debug | `rtsp://VPS_IP:8554/cam` |

### Path `desk` (operator Stream-test loopback)

| Role | URL |
|---|---|
| Built-in test page | `https://mediarelay…/desk` |
| Browser publish (WHIP) | `https://mediarelay…/desk/whip` |
| Browser play (WHEP) | `https://mediarelay…/desk/whep` |

Used by the HID console **Stream-test** tab (`VITE_MEDIA_BASE_URL`). Keep `desk` separate from `cam` so desk tests never fight the Pi publisher.

**Security:** until MediaMTX auth is tightened, anyone who can reach `/desk/whip` (or `/cam/whip`) can publish. Redeploy MediaMTX after changing `mediamtx.yml` (config is baked into the image).

Exact paths follow [MediaMTX WebRTC docs](https://mediamtx.org/docs/).

## Smoke test

1. Deploy; check container logs for listen on `:8889` / `:8189`.
2. Publish a test stream (OBS WHIP or ffmpeg) to `/cam/whip`, **or** use console **Stream-test** against `/desk`.
3. Open `/cam` (or `/desk`) / WHEP in a browser from another network.
4. Then point the Pi camera publisher at the WHIP URL on `cam`.

## Ingest note (Pi Slice C)

Browser Stream-test uses **WHIP** on path `desk` (443 + UDP 8189).  
Pi live publish currently uses **SRT** on path `cam` (UDP **8890**) because stock ffmpeg could not WHIP — see `capture/docs/SLICE_C_SRT.md` in the capture repo.

**Client networks:** some campus / institute Wi‑Fi allow HTTPS **443** to this host but block outbound **UDP 8890**. SRT then fails with ffmpeg `Input/output error` even when the VPS listener and GCP rule are fine. Bypass with WARP/VPN or publish from an unfiltered uplink; details in that capture doc.

## Auth

Current `mediamtx.yml` allows open publish/read for bring-up. Before production, replace `authInternalUsers` with a publish credential for the Pi and restrict read (or put WHEP behind the same session proxy as the operator UI).

## Related

- HID control plane: repo root `Dockerfile` / Coolify HID app  
- Design: `docs/TECH_DESIGN.md` §6  
- Debug / networking write-up (CV): `docs/MEDIAMTX_COOLIFY_CASESTUDY.md`
