# Case study: Public WebRTC media relay on Coolify (MediaMTX)

Portfolio / CV note — remote USB HID operator stack. Camera path is a **separate** video middleman from the HID control plane.

**Stack:** Raspberry Pi (future H.264 WHIP publisher) → MediaMTX on GCP VPS (Coolify) → browser WHEP. HID stays on Node (`/ws/hid`); video never shares those sockets.

**Live hostname (example):** `mediarelay.sahilpatel.online` → `34.42.4.172`  
**Related control UI:** `webrelay.sahilpatel.online` (HID app, same VM class of deploy)

Repo path: `deploy/mediamtx/` (`Dockerfile`, `docker-compose.yml`, `mediamtx.yml`, `README.md`).

---

## Problem

Expose a low-latency camera path over the public internet with:

- TLS at the edge (Let’s Encrypt)
- WHIP ingest + WHEP / HTML playback
- WebRTC ICE that works behind NAT
- Isolation from the HID WebSocket app (security + ops)

MediaMTX was chosen as a dedicated relay (no transcode in the MVP path). Hosting is Coolify (Traefik reverse proxy) on a GCP VM.

---

## Architecture

```
Pi / OBS / ffmpeg          Coolify Traefik              MediaMTX container
(publisher)         →  HTTPS :443  →  proxy → :8889   WHIP /cam/whip
                                                      WHEP /cam/whep
                                                      HTML /cam
Browser (viewer)    →  HTTPS :443  →  proxy → :8889
Browser ICE UDP     ──────────────────────────────→  host :8189/udp → container :8189
```

| Plane | Port | Path through Coolify? |
|--------|------|------------------------|
| WHIP / WHEP / HTML | Container **8889** | Yes — public **443** → Traefik → container |
| WebRTC ICE | **8189/UDP** | No — published on the host; GCP firewall must allow it |
| RTSP debug | **8554** | Prefer closed on public firewall |

Env for ICE candidates (comma-separated, required):

```text
MTX_WEBRTCADDITIONALHOSTS=mediarelay.sahilpatel.online,34.42.4.172
```

---

## Networking & firewall

1. **DNS:** A record `mediarelay.sahilpatel.online` → VPS public IP.
2. **GCP firewall:** ingress allow **UDP 8189** (`allow-mediamtx-webrtc`); **TCP 80/443** already open for Coolify ACME + HTTPS.
3. **Compose:**
   - `expose: ["8889"]` — reachable on the Docker network for Traefik (not the main public HTTP story).
   - `ports: ["8189:8189/udp"]` — ICE must hit the host.
   - Join external network `coolify` so the Coolify proxy can reach the service (see debug notes).
4. **Do not** treat host-mapped `8889` as the primary public HTTP entry; Coolify owns TLS on 443.

---

## Coolify deploy specifics

1. Resource type: **Docker Compose**, base dir `deploy/mediamtx`.
2. **Domain field must include container port** (Coolify routing, not browser URL):

   ```text
   https://mediarelay.sahilpatel.online:8889
   ```

   Users still open `https://mediarelay.sahilpatel.online/…`. The `:8889` tells Traefik the upstream port. Without it, Coolify often targets port **80** → **502**.

3. Config is **baked into the image** (`COPY mediamtx.yml`), not bind-mounted. Coolify had created `mediamtx.yml` as a **directory**, which broke volume mounts — baking avoids that class of failure.
4. Auth left open for bring-up (`authInternalUsers: any`); tighten before production.

Official Coolify notes that match this setup: [Docker Compose domains/ports](https://coolify.io/docs/knowledge-base/docker/compose), [Bad Gateway](https://coolify.io/docs/troubleshoot/applications/bad-gateway).

---

## Debug timeline (what we actually saw)

### 1) Valid TLS + HTTP 502

```bash
curl -vI --max-time 10 https://mediarelay.sahilpatel.online/cam
```

Observed:

- DNS and TCP to `:443` OK  
- TLS 1.3, Let’s Encrypt cert for `mediarelay.sahilpatel.online`, verify OK  
- Response: **`HTTP/2 502`**

**Interpretation:** Certificate and Coolify edge are healthy. Traefik terminated TLS, then **could not reach** the MediaMTX upstream. This is a **proxy → container** problem, not ACME/DNS.

**Fixes applied:**

- Set Coolify domain to `https://…:8889` (upstream port).
- Attach service to external Docker network `coolify` so Traefik and the app share a network.

### 2) MediaMTX healthy in logs

```text
[WebRTC] started with listeners on :8889 (TCP/HTTP), :8189 (UDP/ICE)
```

(MoQ auto.key warning is unrelated to WHIP/WHEP and can be ignored for this MVP.)

### 3) Valid TLS + HTTP 404 + `server: mediamtx`

Same `curl -vI` after the fix:

- Still TLS OK  
- **`HTTP/2 404`**  
- Headers: `server: mediamtx`, `access-control-allow-origin: *`

**Interpretation:** End-to-end proxy path works. MediaMTX answers. Path `cam` has **no live publisher**, so play/HEAD returns not-found.

### 4) Browser: “stream not found” on `/cam/`

Same signal as (3): relay is up; nothing publishing to `cam` yet. Expected until WHIP ingest.

---

## How to prove “video works” next

1. Publish WHIP → `https://mediarelay.sahilpatel.online/cam/whip` (OBS / ffmpeg / Pi).
2. Play → `https://mediarelay.sahilpatel.online/cam/` or WHEP `…/cam/whep`.
3. Confirm MediaMTX logs show a publisher on `cam`, then readers.

---

## Skills demonstrated (CV bullets)

- Split **control plane** (HID WebSockets) from **media plane** (WHIP/WHEP) for security and operability.
- Deployed MediaMTX behind Coolify/Traefik with Let’s Encrypt, correct **container port mapping** in PaaS domain config.
- Diagnosed **502 with a valid cert** as upstream/network routing (not SSL), using layered `curl -vI` evidence.
- Configured **WebRTC ICE** (UDP host publish + `MTX_WEBRTCADDITIONALHOSTS` + cloud firewall).
- Hardened deploy ergonomics (config in image to avoid Coolify mount footguns; documented open-auth bring-up vs production auth).

---

## Related docs in this repo

- Operator design: `docs/TECH_DESIGN.md`  
- Deploy how-to: `deploy/mediamtx/README.md`  
- HID latency self-test log: `docs/SELFTEST_LOG.md`
