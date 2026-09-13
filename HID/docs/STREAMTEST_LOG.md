# Stream-test latency / quality log

Operator **Stream-test** loopback (same PC browser → WHIP → MediaMTX → WHEP → same page).
Glass-to-glass via QR timestamp on published frames (`hidlat:{ms}`).

## Environment

| Item | Value |
|---|---|
| Date | 2026-08-27 |
| Media relay (Runs 1–2) | Dallas (`34.42.4.172`) |
| Media relay (Run 3+) | Mumbai `testin` (`34.47.241.10`) — `mediarelay.sahilpatel.online` |
| UI / control | `webrelay.sahilpatel.online` (HID React SPA; still Dallas in Run 3) |
| Path | Camera → canvas 1920×1080 @ 30 + QR → WHIP → MediaMTX path **`desk`** → WHEP → jsQR |
| CSP | `connect-src` allows media origin + STUN (see `STREAMTEST_NOTES.md`) |
| HQ publish | WHIP `maxBitrate` 6 Mbps, `scaleResolutionDownBy: 1`, `maintain-resolution` |

---

## Run 1 — first successful desk loopback (pre–HQ encode)

Session ~17:33–17:34 UTC. ABR started soft; no forced bitrate yet.

### Glass-to-glass (QR)

| Run | n | p50 | p95 | p99 | loss% | Notes |
|---|---|---|---|---|---|---|
| A (cold / ramp) | 50/50 | **3775 ms** | 4357 ms | 4459 ms | 0.0 | miss ticks 21; ~320×180 / low FPS |
| B (warm) | 50/50 | **555 ms** | 770 ms | 847 ms | 0.0 | miss ticks 13; settled toward 640×360 |

### getStats (after run B)

| Role | RTT | Jitter | FPS | kbps | Drop | Res |
|---|---|---|---|---|---|---|
| whip | 326 ms | — | 30 | 1584 | — | **640×360** |
| whep | 333 ms | 4 ms | 22 | 1759 | 36 | **640×360** |

Mid-session also showed **320×180** at ~7–13 fps before climbing.

### Timeline (abridged)

- WHIP/WHEP ICE gather timeout ~8s → connect OK
- Run A G2G ~3.2–4.5 s while soft; Run B ~0.42–0.85 s
- Clean DELETE on Stop

---

## Run 2 — HQ encode (1080p on the wire)

Session ~17:49–17:51 UTC after HQ WHIP + CSP redeploy. Third table row in UI = this run.

### Glass-to-glass (QR)

| Run | n | p50 | p95 | p99 | loss% | Notes |
|---|---|---|---|---|---|---|
| C (1080p warm) | 50/50 | **667 ms** | 805 ms | 889 ms | 0.0 | miss ticks 23; 1920×1080 @ 30 canvas |

(UI also still showed Run 1 A/B rows from the earlier session in the same paste.)

### getStats (after run C)

| Role | RTT | Jitter | FPS | kbps | Drop | Res |
|---|---|---|---|---|---|---|
| whip | **317 ms** | — | **29** | **2531** | — | **1920×1080** |
| whep | **317 ms** | 9 ms | **26** | **2697** | 7 | **1920×1080** |

Earlier mid-sample snapshot in same session: whip/whep ~318 ms RTT, 23 fps, **1920×1080**.

### Timeline (abridged)

- Camera `1920×1080 @ 30` → canvas `1920×1080`
- WHIP: ICE gather timeout → POST OK → connected (~1.1s after POST)
- WHEP: ICE gather timeout → POST OK → video+audio tracks → connected
- Latency sample ~17:50:50; G2G samples ~485–889 ms
- Stats confirm **1080p** @ ~2.5–2.7 Mbps, ~26–29 fps, low drops
- Clean WHIP/WHEP DELETE on Stop (~17:51:39)

### Raw G2G sample range (run C)

~487–889 ms over 50 unique QR stamps; p50 **667 ms**.

---

## Run 3 — Mumbai MediaMTX (`testin`)

Session ~19:09 UTC (`when`: `2026-08-27T19:09:49.703Z`).  
UI: `webrelay.sahilpatel.online` (Dallas). Media: `mediarelay.sahilpatel.online` → **Mumbai** `34.47.241.10`. Path `desk`. HQ 1080p. Stills: local + received **1920×1080**.

### Glass-to-glass (QR)

| Run | n | p50 | p95 | p99 | loss% | Notes |
|---|---|---|---|---|---|---|
| D | 50/50 | **675 ms** | 1075 ms | 1388 ms | 0.0 | miss ticks 6 |
| E | 50/50 | **668 ms** | 851 ms | **4939 ms** | 0.0 | miss ticks 7; p99 spike outlier |
| F (best) | 50/50 | **598 ms** | 752 ms | 767 ms | 0.0 | miss ticks 7 |

### getStats (Copy JSON snapshot ~19:09:31)

| Role | RTT | Jitter | FPS | kbps | Drop | Res |
|---|---|---|---|---|---|---|
| whip | — (later log ~78 ms) | — | 12 | ~1074 | — | **1920×1080** |
| whep | **76 ms** | 15 ms | — (log ~11–17) | ~1366 | 7 | **1920×1080** |

Log mid-run: WHIP/WHEP RTT **~72–78 ms**, fps ~11–17, res 1920×1080. Clean DELETE on Stop.

### vs Dallas (Run 2)

| Metric | Dallas HQ | Mumbai HQ |
|---|---|---|
| ICE / WHEP RTT | ~317 ms | **~72–78 ms** (~4× better) |
| G2G p50 (best warm) | ~667 ms | **~598 ms** |
| Wire res | 1920×1080 | 1920×1080 |

RTT drop is large; G2G only improved modestly → **encode/canvas/QR pipeline** now dominates more than VPS distance for this loopback.

### Copy JSON (summary)

Saved from clipboard export (`pathHint` webrelay, `mediaBase` mediarelay, `mediaPath` desk). Full `tests` / `peerStats` / `logTail` as provided by operator 2026-08-27.

---

## Interpretation

1. **Mumbai media relay works.** WHEP RTT ~**76 ms** vs Dallas ~**317 ms** — geography fix validated for the media plane.
2. **G2G still ~600–675 ms** at 1080p. With RTT ~75 ms, ~**500+ ms** is local pipeline (canvas re-encode, browser encoder, decoder, QR stamp/sample), not India↔Dallas.
3. **HQ 1080p held** on Mumbai (~1.0–1.4 Mbps in this snapshot; FPS sometimes ~12 — uplink/CPU; stills confirm 1920×1080).
4. **Run E p99 4939 ms** is an outlier; use p50/p95 (and run F) for tuning.
5. **Cold Dallas ~3.8 s** remains invalid. Prefer warm samples after FPS/res stable.
6. Next latency wins: canvas/encode path, warm-up gate, QR cadence — not another region hop for media (unless moving HID UI too).

## Bottlenecks (ordered, after Run 3)

| # | Bottleneck | Evidence | Impact |
|---|---|---|---|
| 1 | **Canvas / encode / QR pipeline** | G2G ~600 ms with RTT ~75 ms | Now the main G2G floor on Mumbai |
| 2 | **Double hop** (WHIP+WHEP) | Loopback both legs | Real Pi→op is one play hop |
| 3 | **Encode FPS dips** | ~12 fps @ 1080 in Run 3 stats | Soft motion; stills OK |
| 4 | **QR / sample cadence** | 10 Hz / 200 ms | Measurement jitter |
| 5 | **ICE gather wait** | Timeouts in older logs | Start UX only |

Dallas RTT (~320 ms) is **mitigated for media** by Mumbai; keep HID on Dallas until UI is migrated if desired.

## How to improve further

1. Reduce canvas re-encode / force stable 30 fps encode on WHIP.
2. Auto warm-up before latency sample.
3. Faster QR stamp / sample interval.
4. Optional: move `webrelay` to Mumbai too (same-region UI + media).
5. Shorten ICE wait for Start UX.

## Target bands

| Metric | Run 2 Dallas HQ | Run 3 Mumbai HQ | Next stretch |
|---|---|---|---|
| ICE / WHEP RTT | ~317 ms | **~75 ms** | ~40–80 ms same-region |
| G2G p50 | ~667 ms | **~598–675 ms** | ~250–400 ms (pipeline tune) |
| Publish res | 1920×1080 | **1920×1080** | keep + stable 30 fps |

## Related

- Gate 7: `docs/DESK_TESTS.md`
- CSP issue: `docs/STREAMTEST_NOTES.md`
- HID Self-test Dallas: `docs/SELFTEST_LOG.md`
