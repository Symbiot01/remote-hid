import { useCallback, useEffect, useRef, useState } from 'react';
import { mediaBaseUrl, mediaPath, whepUrl, whipUrl } from '../lib/mediaConfig';
import {
  collectPeerStats,
  estimateBitrateKbps,
  startLatencySampler,
  startQrOverlayPipeline,
  type LatencySample,
  type OverlayPipeline,
  type PeerStatsSnapshot,
} from '../lib/qrLatencyOverlay';
import { startWhep, type WhepSession } from '../lib/whep';
import { startWhip, type WhipSession } from '../lib/whip';
import {
  downloadSnapshot,
  revokeSnapshot,
  snapshotFromCanvas,
  snapshotFromVideo,
  type FrameSnapshot,
} from '../lib/snapshotFrame';

const SAMPLE_ATTEMPTS = 50;
const SAMPLE_INTERVAL_MS = 200;
const SAMPLE_TIMEOUT_MS = 20_000;

export type StreamTestResult = {
  metric: string;
  n: number;
  attempted: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  lossPct: number;
  notes: string;
};

type Props = {
  active: boolean;
};

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return sorted[idx];
}

function summarize(samples: number[], attempted: number) {
  const sorted = samples.slice().sort((a, b) => a - b);
  const hits = sorted.length;
  const loss = attempted > 0 ? ((attempted - hits) / attempted) * 100 : 0;
  return {
    n: hits,
    attempted,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    lossPct: loss,
  };
}

function fmtMs(v: number | null) {
  if (v == null || Number.isNaN(v)) return '—';
  return `${v.toFixed(1)} ms`;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function StreamTestView({ active }: Props) {
  const localMountRef = useRef<HTMLDivElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [looping, setLooping] = useState(false);
  const [status, setStatus] = useState('Idle — Arm to enable camera / WHIP / WHEP.');
  const [logLines, setLogLines] = useState<string[]>([]);
  const [results, setResults] = useState<StreamTestResult[]>([]);
  const [statsSnap, setStatsSnap] = useState<PeerStatsSnapshot[]>([]);
  const [cameraNote, setCameraNote] = useState('');
  const [stills, setStills] = useState<FrameSnapshot[]>([]);

  const abortRef = useRef(false);
  const overlayRef = useRef<OverlayPipeline | null>(null);
  const whipRef = useRef<WhipSession | null>(null);
  const whepRef = useRef<WhepSession | null>(null);
  const samplerStopRef = useRef<(() => void) | null>(null);

  const appendLog = useCallback((msg: string) => {
    const line = `${new Date().toISOString().slice(11, 23)} ${msg}`;
    setLogLines((prev) => [...prev.slice(-199), line]);
  }, []);

  const teardown = useCallback(async () => {
    samplerStopRef.current?.();
    samplerStopRef.current = null;
    const whip = whipRef.current;
    whipRef.current = null;
    const whep = whepRef.current;
    whepRef.current = null;
    const overlay = overlayRef.current;
    overlayRef.current = null;

    if (whip) {
      try {
        await whip.stop();
      } catch (err) {
        appendLog(`WHIP stop: ${(err as Error).message}`);
      }
    }
    if (whep) {
      try {
        await whep.stop();
      } catch (err) {
        appendLog(`WHEP stop: ${(err as Error).message}`);
      }
    }
    if (overlay) overlay.stop();

    const remote = remoteVideoRef.current;
    if (remote) {
      remote.srcObject = null;
    }
    const mount = localMountRef.current;
    if (mount) mount.replaceChildren();

    setLooping(false);
  }, [appendLog]);

  useEffect(() => {
    if (active) return;
    abortRef.current = true;
    setArmed(false);
    setBusy(false);
    void teardown().then(() => {
      setStatus('Left Stream-test — session torn down.');
    });
  }, [active, teardown]);

  useEffect(() => {
    return () => {
      abortRef.current = true;
      void teardown();
      setStills((prev) => {
        prev.forEach(revokeSnapshot);
        return [];
      });
    };
  }, [teardown]);

  async function captureLocalStill() {
    const canvas = overlayRef.current?.canvas;
    if (!canvas) {
      setStatus('No local canvas — Start loopback first.');
      return;
    }
    try {
      const snap = await snapshotFromCanvas(canvas, 'local');
      setStills((prev) => {
        const next = [snap, ...prev].slice(0, 8);
        prev.slice(7).forEach(revokeSnapshot);
        return next;
      });
      downloadSnapshot(snap);
      appendLog(`Still local ${snap.width}x${snap.height} JPEG`);
      setStatus(`Saved local still ${snap.width}×${snap.height} (full canvas, not RTP).`);
    } catch (err) {
      appendLog(`Still local failed: ${(err as Error).message}`);
      setStatus(`Still failed: ${(err as Error).message}`);
    }
  }

  async function captureReceivedStill() {
    const video = remoteVideoRef.current;
    if (!video) return;
    try {
      const snap = await snapshotFromVideo(video, 'received');
      setStills((prev) => {
        const next = [snap, ...prev].slice(0, 8);
        prev.slice(7).forEach(revokeSnapshot);
        return next;
      });
      downloadSnapshot(snap);
      appendLog(`Still received ${snap.width}x${snap.height} JPEG`);
      setStatus(
        `Saved received still ${snap.width}×${snap.height} (WHEP decoded size — may be softer than local).`
      );
    } catch (err) {
      appendLog(`Still received failed: ${(err as Error).message}`);
      setStatus(`Still failed: ${(err as Error).message}`);
    }
  }
  async function startLoopback() {
    if (!armed || looping || busy) return;
    abortRef.current = false;
    setBusy(true);
    setStatus('Starting camera + QR overlay…');
    appendLog(`Media base ${mediaBaseUrl()} path /${mediaPath()}`);

    try {
      const overlay = await startQrOverlayPipeline({
        onError: (err) => appendLog(`QR overlay: ${err.message}`),
      });
      if (abortRef.current) {
        overlay.stop();
        setBusy(false);
        return;
      }
      overlayRef.current = overlay;

      const settings = overlay.cameraSettings;
      const note = `${settings.width ?? '?'}x${settings.height ?? '?'} @ ${
        settings.frameRate ?? '?'
      } → canvas 1920x1080`;
      setCameraNote(note);
      appendLog(`Camera ${note}`);

      const mount = localMountRef.current;
      if (mount) {
        mount.replaceChildren();
        overlay.canvas.style.width = '100%';
        overlay.canvas.style.height = 'auto';
        overlay.canvas.style.display = 'block';
        overlay.canvas.style.borderRadius = '8px';
        mount.appendChild(overlay.canvas);
      }

      setStatus('WHIP publish…');
      const whip = await startWhip(whipUrl(), overlay.stream, {
        onLog: appendLog,
        highQuality: true,
      });
      if (abortRef.current) {
        await whip.stop();
        overlay.stop();
        overlayRef.current = null;
        setBusy(false);
        return;
      }
      whipRef.current = whip;

      // Brief settle so MediaMTX path is ready for readers.
      await sleep(400);
      if (abortRef.current) {
        await teardown();
        setBusy(false);
        return;
      }

      setStatus('WHEP subscribe…');
      const remote = remoteVideoRef.current;
      const whep = await startWhep(whepUrl(), {
        onLog: appendLog,
        onTrack: (ev) => {
          appendLog(`WHEP track: ${ev.track.kind}`);
          if (!remote) return;
          if (!remote.srcObject) {
            remote.srcObject = new MediaStream();
          }
          const ms = remote.srcObject as MediaStream;
          ms.addTrack(ev.track);
          void remote.play().catch((err) => {
            appendLog(`Remote play: ${(err as Error).message}`);
          });
        },
      });
      if (abortRef.current) {
        await whep.stop();
        await teardown();
        setBusy(false);
        return;
      }
      whepRef.current = whep;

      setLooping(true);
      setStatus('Loopback live — run latency sample when remote video shows QR.');
      appendLog('Loopback running');
    } catch (err) {
      appendLog(`Start failed: ${(err as Error).message}`);
      setStatus(`Start failed: ${(err as Error).message}`);
      await teardown();
    } finally {
      setBusy(false);
    }
  }

  async function stopLoopback() {
    abortRef.current = true;
    setBusy(true);
    setStatus('Stopping…');
    await teardown();
    setBusy(false);
    setStatus(armed ? 'Stopped. Arm still on — Start again when ready.' : 'Stopped.');
  }

  async function refreshStats() {
    const snaps: PeerStatsSnapshot[] = [];
    if (whipRef.current) {
      const s = await collectPeerStats(whipRef.current.pc, 'whip');
      try {
        s.bitrateKbps = await estimateBitrateKbps(whipRef.current.pc, 'whip', 800);
      } catch {
        // ignore
      }
      snaps.push(s);
      appendLog(
        `WHIP stats RTT=${fmtMs(s.rttMs)} fps=${s.framesPerSecond ?? '—'} res=${s.resolution ?? '—'}`
      );
    }
    if (whepRef.current) {
      const s = await collectPeerStats(whepRef.current.pc, 'whep');
      try {
        s.bitrateKbps = await estimateBitrateKbps(whepRef.current.pc, 'whep', 800);
      } catch {
        // ignore
      }
      snaps.push(s);
      appendLog(
        `WHEP stats RTT=${fmtMs(s.rttMs)} jitter=${fmtMs(s.jitterMs)} fps=${
          s.framesPerSecond ?? '—'
        } drop=${s.framesDropped ?? '—'} res=${s.resolution ?? '—'}`
      );
    }
    setStatsSnap(snaps);
  }

  async function runLatencySample() {
    if (!armed || !looping || busy) return;
    const remote = remoteVideoRef.current;
    if (!remote) return;

    abortRef.current = false;
    setBusy(true);
    setStatus(`Sampling glass-to-glass (${SAMPLE_ATTEMPTS} unique QR stamps)…`);
    appendLog('Latency sample started');

    const samples: number[] = [];
    let misses = 0;
    const t0 = performance.now();

    await new Promise<void>((resolve) => {
      const handle = startLatencySampler(remote, {
        intervalMs: SAMPLE_INTERVAL_MS,
        onSample: (s: LatencySample) => {
          samples.push(s.latencyMs);
          appendLog(`G2G ${s.latencyMs.toFixed(0)} ms (${samples.length}/${SAMPLE_ATTEMPTS})`);
          if (samples.length >= SAMPLE_ATTEMPTS || abortRef.current) {
            handle.stop();
            resolve();
          }
        },
        onMiss: () => {
          misses += 1;
          if (abortRef.current || performance.now() - t0 > SAMPLE_TIMEOUT_MS) {
            handle.stop();
            resolve();
          }
        },
      });
      samplerStopRef.current = () => {
        handle.stop();
        resolve();
      };

      window.setTimeout(() => {
        if (samples.length < SAMPLE_ATTEMPTS) {
          handle.stop();
          resolve();
        }
      }, SAMPLE_TIMEOUT_MS);
    });

    samplerStopRef.current = null;

    const summary = summarize(samples, SAMPLE_ATTEMPTS);
    const row: StreamTestResult = {
      metric: 'Glass-to-glass (QR)',
      ...summary,
      notes: `miss ticks ${misses}; ${cameraNote || 'camera n/a'}`,
    };
    setResults((prev) => [...prev, row]);
    await refreshStats();
    setStatus(
      abortRef.current
        ? 'Latency sample aborted'
        : `Latency sample done — p50 ${fmtMs(summary.p50)} (n=${summary.n})`
    );
    setBusy(false);
  }

  async function copyJson() {
    const payload = {
      when: new Date().toISOString(),
      pathHint: window.location.host,
      mediaBase: mediaBaseUrl(),
      mediaPath: mediaPath(),
      cameraNote,
      tests: results,
      peerStats: statsSnap,
      logTail: logLines.slice(-80),
    };
    const text = JSON.stringify(payload, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setStatus('Results copied to clipboard');
    } catch {
      setStatus('Clipboard failed — see console');
      console.log(text);
    }
  }

  const canStart = armed && !looping && !busy;
  const canSample = armed && looping && !busy;
  const canStop = looping || busy;

  return (
    <section className="card selftest-card streamtest-card">
      <p className="selftest-warn">
        Same-PC loopback: camera → QR timestamp overlay → WHIP{' '}
        <code>/{mediaPath()}/whip</code> → MediaMTX → WHEP → this page. Measures glass-to-glass
        on one clock. Prefer 1080p; actual capture is noted in logs. Use{' '}
        <strong>Snap local</strong> (or click the local pane) for a sharp JPEG of the full
        1920×1080 canvas — independent of WebRTC ABR. Path <code>desk</code> is separate from
        Pi <code>cam</code>. MediaMTX publish is currently open until auth is tightened.
      </p>

      <div className="streamtest-grid">
        <figure className="streamtest-pane">
          <figcaption>Local (publish canvas) — click to snap 1080 JPEG</figcaption>
          <div
            ref={localMountRef}
            className="streamtest-video-slot streamtest-clickable"
            role="button"
            tabIndex={0}
            title="Click to save full-resolution local still"
            onClick={() => {
              if (looping || overlayRef.current) void captureLocalStill();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (looping || overlayRef.current) void captureLocalStill();
              }
            }}
          />
        </figure>
        <figure className="streamtest-pane">
          <figcaption>Received (WHEP) — click to snap decoded frame</figcaption>
          <video
            ref={remoteVideoRef}
            className="streamtest-video streamtest-clickable"
            playsInline
            muted
            autoPlay
            title="Click to save received still"
            onClick={() => {
              if (looping) void captureReceivedStill();
            }}
          />
        </figure>
      </div>

      <div className="selftest-controls">
        <label className="selftest-arm">
          <input
            type="checkbox"
            checked={armed}
            disabled={busy && looping}
            onChange={(e) => {
              const next = e.target.checked;
              setArmed(next);
              if (next) {
                setStatus('Armed — Start loopback when ready.');
              } else {
                abortRef.current = true;
                void stopLoopback().then(() => setStatus('Disarmed.'));
              }
            }}
          />
          <span>Arm</span>
        </label>
        <button type="button" className="btn primary" disabled={!canStart} onClick={() => void startLoopback()}>
          Start loopback
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={!canSample}
          onClick={() => void runLatencySample()}
        >
          Run latency sample
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={!looping || busy}
          onClick={() => void refreshStats()}
        >
          Snapshot getStats
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={!looping}
          title="Full 1920×1080 JPEG from local canvas (not RTP)"
          onClick={() => void captureLocalStill()}
        >
          Snap local (1080)
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={!looping}
          title="JPEG from WHEP video at decoded resolution"
          onClick={() => void captureReceivedStill()}
        >
          Snap received
        </button>
        <button type="button" className="btn ghost" disabled={!canStop} onClick={() => void stopLoopback()}>
          Stop
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={results.length === 0 && statsSnap.length === 0}
          onClick={() => void copyJson()}
        >
          Copy JSON
        </button>
      </div>

      <p className="muted selftest-status" aria-live="polite">
        {status}
        {cameraNote ? ` · ${cameraNote}` : ''}
      </p>

      <div className="selftest-table-wrap">
        <table className="selftest-table">
          <thead>
            <tr>
              <th>Metric</th>
              <th>n</th>
              <th>p50</th>
              <th>p95</th>
              <th>p99</th>
              <th>loss%</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {results.length === 0 ? (
              <tr className="empty">
                <td colSpan={7}>No latency runs yet</td>
              </tr>
            ) : (
              results.map((row, i) => (
                <tr key={`${row.metric}-${i}`}>
                  <td>{row.metric}</td>
                  <td>
                    {row.n}/{row.attempted}
                  </td>
                  <td>{fmtMs(row.p50)}</td>
                  <td>{fmtMs(row.p95)}</td>
                  <td>{fmtMs(row.p99)}</td>
                  <td>{row.lossPct.toFixed(1)}</td>
                  <td>{row.notes}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {statsSnap.length > 0 ? (
        <div className="selftest-table-wrap">
          <table className="selftest-table">
            <thead>
              <tr>
                <th>Role</th>
                <th>RTT</th>
                <th>Jitter</th>
                <th>FPS</th>
                <th>kbps</th>
                <th>Drop</th>
                <th>Res</th>
              </tr>
            </thead>
            <tbody>
              {statsSnap.map((s) => (
                <tr key={`${s.role}-${s.when}`}>
                  <td>{s.role}</td>
                  <td>{fmtMs(s.rttMs)}</td>
                  <td>{fmtMs(s.jitterMs)}</td>
                  <td>{s.framesPerSecond ?? '—'}</td>
                  <td>{s.bitrateKbps != null ? s.bitrateKbps.toFixed(0) : '—'}</td>
                  <td>{s.framesDropped ?? '—'}</td>
                  <td>{s.resolution ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {stills.length > 0 ? (
        <div className="streamtest-stills" aria-label="Recent stills">
          {stills.map((s) => (
            <button
              key={s.id}
              type="button"
              className="streamtest-still"
              title={`${s.source} ${s.width}×${s.height} — click to re-download`}
              onClick={() => downloadSnapshot(s)}
            >
              <img src={s.objectUrl} alt={`${s.source} ${s.width}x${s.height}`} />
              <span>
                {s.source} {s.width}×{s.height}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="streamtest-log" aria-label="Stream event log">
        {logLines.length === 0 ? (
          <span className="muted">Event log empty</span>
        ) : (
          logLines.map((line, i) => (
            <div key={`${i}-${line.slice(0, 12)}`}>{line}</div>
          ))
        )}
      </div>
    </section>
  );
}
