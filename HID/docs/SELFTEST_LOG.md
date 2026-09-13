# Self-test latency log

Operator Self-test loopback (same PC + ESP32 HID + public relay).
Measured via Operator Console → **Self-test** tab (inject-only; no echo).

## Environment

| Item | Value |
|---|---|
| Date | 2026-08-27 |
| Relay | Public VPS (Dallas, US) |
| Path | Browser → WSS → Dallas → ESP32 (Wi‑Fi) → USB HID → same OS → browser |
| UI | React SPA (`HID/web`) |
| Firmware | `web-hid` keyboard + mouse (op 4) |
| Mouse live rate | Browser `mousemove`, server cap **250 frames/s** |
| Square / nudge | **3 px / 8 ms** (~125 Hz) |

## Run results (Dallas)

Status line noted: `Square smoke done in 2705 ms`

| Metric | n | p50 | p95 | p99 | loss% | Notes |
|---|---|---|---|---|---|---|
| Keyboard down RTT | 100/100 | 285.6 ms | 298.4 ms | 520.2 ms | 0.0 | KeyF; gap 40ms |
| Keyboard up RTT | 100/100 | 286.0 ms | 298.7 ms | 476.6 ms | 0.0 | KeyF |
| Click down RTT | 50/50 | 289.3 ms | 307.8 ms | 960.2 ms | 0.0 | left button on hit pad |
| Click up RTT | 50/50 | 286.3 ms | 303.2 ms | 312.2 ms | 0.0 | left button |
| Burst 100/s | 100/100 | — | — | — | 0.0 | 100 keydowns in 1605ms |
| Burst 250/s | 100/100 | — | — | — | 0.0 | 100 keydowns in 1813ms |
| Burst 250/s | 100/100 | — | — | — | 0.0 | 100 keydowns in 1115ms |
| Square smoke | 1/1 | 2710.9 ms | 2710.9 ms | 2710.9 ms | 0.0 | wall-clock; move accuracy qualitative |
| Burst 250/s | 100/100 | — | — | — | 0.0 | 100 keydowns in 1068ms |
| Burst 100/s | 100/100 | — | — | — | 0.0 | 100 keydowns in 1504ms |
| Burst 250/s | 100/100 | — | — | — | 0.0 | 100 keydowns in 1731ms |
| Click down RTT | 50/50 | 285.9 ms | 362.1 ms | 942.6 ms | 0.0 | left button on hit pad |
| Click up RTT | 49/50 | 284.4 ms | 295.4 ms | 519.7 ms | 2.0 | left button |
| Square smoke | 1/1 | 2705.2 ms | 2705.2 ms | 2705.2 ms | 0.0 | wall-clock; move accuracy qualitative |

## Interpretation

- **p50 ~285–290 ms** for keys/clicks is dominated by **India ↔ Dallas WAN**, not Node/React overhead.
- **0% loss** on most bursts at 100/s and 250/s → forwarder + firmware keep up.
- **Square ~2.7 s** is scripted pacing (`4 × 240/3 × 8 ms ≈ 2.56 s`), not RTT.
- Occasional **p99 spikes** (500–960 ms) are consistent with Wi‑Fi / OS scheduling jitter.

## Expected if relay were in India (estimate only)

| Setup | Likely key/click p50 |
|---|---|
| Dallas (measured) | ~280–300 ms |
| India VPS (same region as operator + ESP32) | ~40–90 ms |
| India VPS (cross-city domestic) | ~60–120 ms |
| LAN / local Node (no public VPS) | ~15–40 ms |

**Update:** 2026-08-27 India-region Self-test measured **~57–64 ms** keyboard/click p50 — see section below. Estimate validated.

## Mouse smoothness notes

- Live feel on Dallas was limited first by **~290 ms RTT** (delayed relative moves).
- With India-region relay (**~57–64 ms**), feel should track much closer; OS pointer acceleration still distorts relative HID deltas.
- Live transfer frequency: up to **250/s** (server gate); Square/nudge fixed at **125 Hz**.

---

## Run — 2026-08-27 (India-region / low RTT)

Status line: `Keyboard RTT done — down p50 57.0 ms, loss 0.0%`  
Same Self-test loopback (inject-only). UI via `webrelay.sahilpatel.online` after media moved to Mumbai `testin`; HID path now measures **~57–64 ms** p50 (vs Dallas **~285–290 ms**).

| Metric | n | p50 | p95 | p99 | loss% | Notes |
|---|---|---|---|---|---|---|
| Keyboard down RTT | 100/100 | 64.3 ms | 84.3 ms | 110.0 ms | 0.0 | KeyF; gap 40ms |
| Keyboard up RTT | 100/100 | 63.3 ms | 84.0 ms | 95.0 ms | 0.0 | KeyF |
| Burst 100/s | 100/100 | — | — | — | 0.0 | 100 keydowns in 1100ms |
| Burst 250/s | 100/100 | — | — | — | 0.0 | 100 keydowns in 764ms |
| Square smoke | 1/1 | 2689.1 ms | 2689.1 ms | 2689.1 ms | 0.0 | wall-clock; paced |
| Square smoke | 1/1 | 2672.6 ms | 2672.6 ms | 2672.6 ms | 0.0 | wall-clock; paced |
| Burst 250/s | 100/100 | — | — | — | 0.0 | 100 keydowns in **503ms** |
| Burst 100/s | 100/100 | — | — | — | 0.0 | 100 keydowns in 1052ms |
| Click down RTT | 50/50 | 59.1 ms | 69.9 ms | 70.2 ms | 0.0 | left button on hit pad |
| Click up RTT | 50/50 | 59.6 ms | 70.5 ms | 77.5 ms | 0.0 | left button |
| Click down RTT | 50/50 | 155.6 ms | 219.8 ms | 233.6 ms | 0.0 | slower pass (focus/Wi‑Fi?) |
| Click up RTT | 50/50 | 160.6 ms | 223.6 ms | 233.6 ms | 0.0 | same pass |
| Click down RTT | 49/50 | 69.0 ms | 237.8 ms | 661.1 ms | 2.0 | some misses / p99 spike |
| Click up RTT | 48/50 | 63.0 ms | 228.7 ms | 245.6 ms | 4.0 | some misses |
| Keyboard down RTT | 100/100 | **57.0 ms** | 67.5 ms | 86.0 ms | 0.0 | KeyF; gap 40ms (best) |
| Keyboard up RTT | 100/100 | **57.4 ms** | 65.1 ms | 67.5 ms | 0.0 | KeyF |

### Interpretation (India-region)

- **Key/click p50 ~57–64 ms** matches the earlier **India VPS estimate (~40–90 ms)** and is roughly **5× faster** than Dallas (~285 ms).
- **Geography was the HID bottleneck**; Node/React/firmware were never the ~285 ms floor.
- **Bursts** stay **0% loss**; 250/s completed in **503–764 ms** wall time (Dallas bursts were often 1.0–1.8 s) → path + device keep up under load.
- **Square ~2.67–2.69 s** unchanged (scripted pacing), as expected.
- **Click variance:** one pass ~59 ms (clean); one ~155–160 ms; one with 2–4% loss and high p99 — keep hit pad focused / avoid OS stealing clicks; treat **~57–70 ms** as the good baseline.
- Aligns with Stream-test Run 3: Mumbai media WHEP RTT ~**76 ms**; HID Self-test ~**57 ms** — same regional story.

### Dallas vs India-region (summary)

| Metric | Dallas | This run (best) |
|---|---|---|
| Keyboard down p50 | ~286 ms | **~57 ms** |
| Click down p50 (clean) | ~286–289 ms | **~59 ms** |
| Burst 250/s duration | ~1.1–1.8 s | **~0.5–0.76 s** |
| Square smoke | ~2.7 s | ~2.7 s (paced) |

## Append next runs

Copy JSON from Self-test **Copy JSON**, or paste a new table under a new `## Run — YYYY-MM-DD (region)` heading.
