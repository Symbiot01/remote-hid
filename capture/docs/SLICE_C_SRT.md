# Slice C — why SRT (not WHIP via stock ffmpeg)

## Goal

Pi Camera Module 3 → public MediaMTX (`mediarelay.sahilpatel.online`) → browser at `/cam` (WHEP/HTML), **same media plane** as Stream-test, path **`cam`** (not `desk`).

## What already worked

| Piece | Evidence |
|-------|----------|
| MediaMTX on VPS | Stream-test WHIP/WHEP on path **`desk`** |
| Ports for WebRTC | **443** (HTTPS via Coolify) + **UDP 8189** (ICE) |
| Pi camera / encode | Slice A (`imx708`) + Slice B (720p30 H.264) + still API |

Opening **`/cam`** during Stream-test stays empty on purpose: Stream-test publishes to **`/desk` only**.

## What did not work

### 1. Stock ffmpeg as WHIP client (`-f webrtc` / WHIP)

Attempted pattern:

```bash
rpicam-vid -t 0 --inline … -o - | \
  ffmpeg … -f h264 -i - -c:v copy -f webrtc "$WHIP_URL"
```

**Result:** `whip.service` crash-looped (e.g. exit status **234**). Camera often started (imx708 / mode selection in logs; headless “preview unavailable” is normal), then **ffmpeg exited** because the distro ffmpeg build **does not support** WebRTC/WHIP output the way we need.

So: **encode OK, WHIP publisher missing.**

### 2. “Same door” confusion

Stream-test uses:

1. HTTPS WHIP signaling on **443**
2. Media on **UDP 8189**

That door is open and proven. The Pi never completed step (1) with a real WHIP client, so it never used 8189 for `/cam`.

**Not a VPS 8189 firewall bug** for this failure mode.

### 3. RTSP fallback (`:8554`)

ffmpeg *can* push RTSP, and MediaMTX can bridge to WHEP — but:

- Needs **TCP/UDP 8554** reachable on the public VPS (extra firewall door).
- Over the internet, RTSP often needs **`-rtsp_transport tcp`**, which usually **costs latency** vs UDP-oriented ingest.
- We prefer not to expose RTSP publicly long-term.

RTSP was considered only as a quick hack, not the preferred design.

## Why we are shifting to SRT

| | WHIP (ideal) | Stock ffmpeg WHIP | RTSP :8554 | **SRT :8890** |
|--|--------------|-------------------|------------|----------------|
| ffmpeg on Pi | Needs capable build / other client | **Failed** | Works | **Works** |
| Extra VPS port | No (443+8189) | — | 8554 | **8890/udp** |
| Latency vs WHIP | Best fit | — | Often worse (TCP) | **Acceptable** (UDP + tunable latency) |
| Browser play | WHEP | — | WHEP | **WHEP** (MediaMTX remux, no H.264 transcode if copy) |

**SRT** lets us keep using **stock ffmpeg** on the Pi (`-f mpegts` → `srt://…?streamid=publish:cam`) while MediaMTX still serves **WHEP** to the operator UI.

Tradeoff: open **UDP 8890** on GCP + publish `8890:8890/udp` on the MediaMTX container (enable `srt: yes` in `mediamtx.yml`). Prefer tightening auth later; treat public SRT like temporary ingest, not a permanent open camera API.

## Campus / institute WiFi blocks SRT (client-side)

**Symptom:** After MediaMTX is correctly deployed (`srt: yes`, host `8890/udp`, GCP `allow-testin-srt`), ffmpeg from a laptop on institute WiFi still fails:

```text
Connection to srt://mediarelay…:8890?streamid=publish:cam… failed: Input/output error
```

**Not a VPS bug** when:

| Check | Expected when VPS is OK |
|-------|-------------------------|
| VPS `ss -lun \| grep 8890` | Listening `0.0.0.0:8890` |
| GCP firewall | `allow-testin-srt` → UDP 8890 → tag `testin` |
| HTTPS `/cam` from laptop | **200** (TCP 443 allowed) |
| SRT from same laptop | **I/O error** |

**Root cause (confirmed 2026-08-28):** institute / campus egress firewall allows **HTTPS (TCP 443)** to `mediarelay` but blocks outbound **UDP 8890** (SRT). Same failure to raw IP `34.47.241.10:8890` → not DNS.

**Evidence**

| Path | Public IP (example) | HTTPS `/cam` | SRT `:8890` |
|------|---------------------|--------------|-------------|
| Institute WiFi direct | `203.110.247.87` | OK | **Fail** |
| Same laptop + Cloudflare WARP (`warp-cli connect`) | WARP egress | OK | **OK** |

WARP tunnels UDP past the campus filter; disconnecting WARP reproduces the failure immediately.

**Workarounds (publisher side)**

1. `warp-cli connect` (or another VPN) when publishing SRT from campus WiFi.
2. Use a network that allows UDP 8890 (home, phone hotspot, non-filtered lab).
3. Publish from the **Pi** on an uplink that is not filtered the same way (do not assume campus WiFi = Pi uplink).

**Do not confuse with:** Coolify deploy missing `srt: yes` / compose `8890:8890/udp` (VPS has no listener). That also yields I/O error — check `ss` / GCP first, then campus egress.

## Longer-term (optional)

Revisit **WHIP** with MediaMTX-on-Pi or a WHIP-capable client so ingest uses only **443 + 8189** again (same door as Stream-test, no 8890).

## Pass criteria for SRT Slice C

1. MediaMTX logs SRT listener on **:8890** and a publisher on path **`cam`**.
2. `https://mediarelay.sahilpatel.online/cam` shows live 720p (not “stream not found”).
3. HID keys/mouse still work while video runs (separate plane).

## Related

- Capture scripts: `scripts/publish_whip.sh` (to be SRT publisher; name historical)
- VPS MediaMTX: `HID/deploy/mediamtx/`
- Desk loopback notes: `HID/docs/STREAMTEST_NOTES.md`, `HID/docs/STREAMTEST_LOG.md`


