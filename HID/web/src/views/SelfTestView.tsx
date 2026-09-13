import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildFrame,
  buildMouseFrame,
  hidUsageFromCode,
  OP_KEY_DOWN,
  OP_KEY_UP,
  OP_RELEASE_ALL,
} from '../lib/keymap';

const KEY_CODE = 'KeyF';
const KEYBOARD_N = 100;
const KEYBOARD_GAP_MS = 40;
const CLICK_N = 50;
const CLICK_GAP_MS = 80;
const BURST_N = 100;
const TIMEOUT_MS = 2000;
const SQUARE_SIDE = 240;
const SQUARE_STEP = 3;
const SQUARE_MS = 8;

export type SelfTestResult = {
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
  deviceReady: boolean;
  sendBinary: (buf: ArrayBuffer) => boolean;
  active: boolean;
};

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

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

export function SelfTestView({ deviceReady, sendBinary, active }: Props) {
  const padRef = useRef<HTMLDivElement>(null);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Idle — Arm to enable inject tests.');
  const [padLabel, setPadLabel] = useState('Hit pad — click here, then Arm');
  const [results, setResults] = useState<SelfTestResult[]>([]);
  const abortRef = useRef(false);
  const squareTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyUsage = hidUsageFromCode(KEY_CODE);

  const releaseAll = useCallback(() => {
    sendBinary(buildFrame(OP_RELEASE_ALL));
  }, [sendBinary]);

  const cancelSquareTimer = useCallback(() => {
    if (squareTimer.current != null) {
      clearTimeout(squareTimer.current);
      squareTimer.current = null;
    }
  }, []);

  useEffect(() => {
    if (!active) {
      abortRef.current = true;
      cancelSquareTimer();
      setArmed(false);
      setBusy(false);
      if (deviceReady) {
        try {
          sendBinary(buildFrame(OP_RELEASE_ALL));
        } catch {
          // ignore
        }
      }
      setStatus('Idle — Arm to enable inject tests.');
      setPadLabel('Hit pad — click here, then Arm');
    } else {
      abortRef.current = false;
      padRef.current?.focus();
      setStatus(
        deviceReady
          ? 'Self-test ready — Arm, then run a probe. Do not type during runs.'
          : 'Waiting for device + WebSocket…'
      );
    }
  }, [active, deviceReady, sendBinary, cancelSquareTimer]);

  useEffect(() => {
    if (!busy) {
      setPadLabel(armed ? 'Armed — keep focus here; run a test' : 'Hit pad — click here, then Arm');
    }
  }, [armed, busy]);

  function injectBinary(buf: ArrayBuffer): boolean {
    if (!deviceReady || abortRef.current) return false;
    if (!busy && !armed) return false;
    return sendBinary(buf);
  }

  async function beginRun(label: string): Promise<boolean> {
    if (!armed || busy || !deviceReady) return false;
    abortRef.current = false;
    setBusy(true);
    padRef.current?.focus();
    setPadLabel(label);
    setStatus(label);
    releaseAll();
    await sleep(30);
    return true;
  }

  async function endRun() {
    cancelSquareTimer();
    releaseAll();
    setBusy(false);
    abortRef.current = false;
  }

  function pushResult(metric: string, summary: ReturnType<typeof summarize>, notes: string) {
    setResults((prev) => [
      ...prev,
      {
        metric,
        n: summary.n,
        attempted: summary.attempted,
        p50: summary.p50,
        p95: summary.p95,
        p99: summary.p99,
        lossPct: summary.lossPct,
        notes,
      },
    ]);
  }

  function probeKey(type: 'keydown' | 'keyup', code: string, frame: ArrayBuffer) {
    return new Promise<number | null>((resolve) => {
      let done = false;
      const timer = setTimeout(() => finish(null), TIMEOUT_MS);

      function onEvent(event: KeyboardEvent) {
        if (event.code !== code || event.repeat) return;
        event.preventDefault();
        event.stopPropagation();
        finish(performance.now() - t0);
      }

      function finish(value: number | null) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener(type, onEvent, true);
        resolve(abortRef.current ? null : value);
      }

      window.addEventListener(type, onEvent, true);
      const t0 = performance.now();
      if (!injectBinary(frame)) finish(null);
    });
  }

  function probePadMouse(type: 'mousedown' | 'mouseup', buttons: number) {
    return new Promise<number | null>((resolve) => {
      const pad = padRef.current;
      if (!pad) {
        resolve(null);
        return;
      }
      let done = false;
      const timer = setTimeout(() => finish(null), TIMEOUT_MS);

      function onEvent(event: MouseEvent) {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        finish(performance.now() - t0);
      }

      function finish(value: number | null) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pad?.removeEventListener(type, onEvent, true);
        resolve(abortRef.current ? null : value);
      }

      pad.addEventListener(type, onEvent, true);
      const t0 = performance.now();
      if (!injectBinary(buildMouseFrame(buttons, 0, 0, 0))) finish(null);
    });
  }

  async function runKeyboardRtt() {
    if (!(await beginRun('Keyboard RTT running…'))) return;
    if (keyUsage == null) {
      setStatus('KeyF usage missing from keymap');
      await endRun();
      return;
    }
    const downSamples: number[] = [];
    const upSamples: number[] = [];

    for (let i = 0; i < KEYBOARD_N; i += 1) {
      if (abortRef.current || !deviceReady) break;
      setStatus(`Keyboard RTT ${i + 1}/${KEYBOARD_N}`);
      setPadLabel(`Keyboard ${i + 1}/${KEYBOARD_N}`);

      const downMs = await probeKey('keydown', KEY_CODE, buildFrame(OP_KEY_DOWN, keyUsage));
      if (downMs == null) {
        injectBinary(buildFrame(OP_KEY_UP, keyUsage));
        releaseAll();
        await sleep(KEYBOARD_GAP_MS);
        continue;
      }
      downSamples.push(downMs);

      const upMs = await probeKey('keyup', KEY_CODE, buildFrame(OP_KEY_UP, keyUsage));
      if (upMs == null) releaseAll();
      else upSamples.push(upMs);
      await sleep(KEYBOARD_GAP_MS);
    }

    const downSummary = summarize(downSamples, KEYBOARD_N);
    const upSummary = summarize(upSamples, KEYBOARD_N);
    pushResult('Keyboard down RTT', downSummary, `KeyF; gap ${KEYBOARD_GAP_MS}ms`);
    pushResult('Keyboard up RTT', upSummary, 'KeyF');
    setStatus(
      abortRef.current
        ? 'Keyboard RTT aborted'
        : `Keyboard RTT done — down p50 ${fmtMs(downSummary.p50)}, loss ${downSummary.lossPct.toFixed(1)}%`
    );
    await endRun();
  }

  async function runClickRtt() {
    if (!(await beginRun('Click RTT — keep cursor on hit pad…'))) return;
    setStatus('Click RTT — move system cursor onto the hit pad, then waiting…');
    await sleep(800);
    const downSamples: number[] = [];
    const upSamples: number[] = [];

    for (let i = 0; i < CLICK_N; i += 1) {
      if (abortRef.current || !deviceReady) break;
      setStatus(`Click RTT ${i + 1}/${CLICK_N}`);
      setPadLabel(`Click ${i + 1}/${CLICK_N}`);
      padRef.current?.focus();

      const downMs = await probePadMouse('mousedown', 0x01);
      if (downMs == null) {
        injectBinary(buildMouseFrame(0, 0, 0, 0));
        releaseAll();
        await sleep(CLICK_GAP_MS);
        continue;
      }
      downSamples.push(downMs);

      const upMs = await probePadMouse('mouseup', 0x00);
      if (upMs == null) releaseAll();
      else upSamples.push(upMs);
      await sleep(CLICK_GAP_MS);
    }

    const downSummary = summarize(downSamples, CLICK_N);
    const upSummary = summarize(upSamples, CLICK_N);
    pushResult('Click down RTT', downSummary, 'left button on hit pad');
    pushResult('Click up RTT', upSummary, 'left button');
    setStatus(
      abortRef.current
        ? 'Click RTT aborted'
        : `Click RTT done — down p50 ${fmtMs(downSummary.p50)}, loss ${downSummary.lossPct.toFixed(1)}%`
    );
    await endRun();
  }

  async function runBurst(ratePerSec: number) {
    if (!(await beginRun(`Burst ${ratePerSec}/s running…`))) return;
    if (keyUsage == null) {
      setStatus('KeyF usage missing from keymap');
      await endRun();
      return;
    }
    const intervalMs = 1000 / ratePerSec;
    let received = 0;

    function onKeyDown(event: KeyboardEvent) {
      if (event.code !== KEY_CODE || event.repeat) return;
      event.preventDefault();
      event.stopPropagation();
      received += 1;
    }

    window.addEventListener('keydown', onKeyDown, true);
    const tStart = performance.now();

    for (let i = 0; i < BURST_N; i += 1) {
      if (abortRef.current || !deviceReady) break;
      setStatus(`Burst ${ratePerSec}/s ${i + 1}/${BURST_N}`);
      setPadLabel(`Burst ${i + 1}/${BURST_N}`);
      injectBinary(buildFrame(OP_KEY_DOWN, keyUsage));
      injectBinary(buildFrame(OP_KEY_UP, keyUsage));
      const target = tStart + (i + 1) * intervalMs;
      const wait = target - performance.now();
      if (wait > 0) await sleep(wait);
    }

    const drainUntil = performance.now() + TIMEOUT_MS;
    while (performance.now() < drainUntil && !abortRef.current) {
      setStatus(`Burst ${ratePerSec}/s draining… (${received}/${BURST_N})`);
      await sleep(50);
      if (received >= BURST_N) break;
    }
    window.removeEventListener('keydown', onKeyDown, true);

    const got = Math.min(received, BURST_N);
    const loss = BURST_N > 0 ? ((BURST_N - got) / BURST_N) * 100 : 0;
    const elapsed = performance.now() - tStart;
    pushResult(
      `Burst ${ratePerSec}/s`,
      { n: got, attempted: BURST_N, p50: null, p95: null, p99: null, lossPct: loss },
      `${received} keydowns in ${elapsed.toFixed(0)}ms`
    );
    setStatus(
      abortRef.current
        ? `Burst ${ratePerSec}/s aborted`
        : `Burst ${ratePerSec}/s done — got ${received}/${BURST_N}, loss ${loss.toFixed(1)}%`
    );
    await endRun();
  }

  function runMicroSide(dxTotal: number, dyTotal: number) {
    return new Promise<boolean>((resolve) => {
      const signX = dxTotal === 0 ? 0 : dxTotal > 0 ? 1 : -1;
      const signY = dyTotal === 0 ? 0 : dyTotal > 0 ? 1 : -1;
      let remain = Math.max(Math.abs(dxTotal), Math.abs(dyTotal));

      function step() {
        squareTimer.current = null;
        if (abortRef.current || !deviceReady) {
          resolve(false);
          return;
        }
        if (remain <= 0) {
          resolve(true);
          return;
        }
        const mag = Math.min(SQUARE_STEP, remain);
        const dx = signX * (dxTotal !== 0 ? mag : 0);
        const dy = signY * (dyTotal !== 0 ? mag : 0);
        remain -= mag;
        injectBinary(buildMouseFrame(0, dx, dy, 0));
        squareTimer.current = setTimeout(step, SQUARE_MS);
      }
      step();
    });
  }

  async function runSquareSmoke() {
    if (!(await beginRun('Square smoke running…'))) return;
    const t0 = performance.now();
    const sides: [number, number][] = [
      [SQUARE_SIDE, 0],
      [0, SQUARE_SIDE],
      [-SQUARE_SIDE, 0],
      [0, -SQUARE_SIDE],
    ];
    let ok = true;
    for (let i = 0; i < sides.length; i += 1) {
      if (abortRef.current) {
        ok = false;
        break;
      }
      setStatus(`Square smoke side ${i + 1}/4`);
      setPadLabel(`Square side ${i + 1}/4`);
      const sideOk = await runMicroSide(sides[i][0], sides[i][1]);
      if (!sideOk) {
        ok = false;
        break;
      }
    }
    cancelSquareTimer();
    const elapsed = performance.now() - t0;
    pushResult(
      'Square smoke',
      {
        n: ok ? 1 : 0,
        attempted: 1,
        p50: elapsed,
        p95: elapsed,
        p99: elapsed,
        lossPct: ok ? 0 : 100,
      },
      'wall-clock; move accuracy qualitative'
    );
    setStatus(abortRef.current || !ok ? 'Square smoke aborted' : `Square smoke done in ${elapsed.toFixed(0)} ms`);
    await endRun();
  }

  function abort() {
    if (!busy) return;
    abortRef.current = true;
    cancelSquareTimer();
    releaseAll();
    setStatus('Aborting…');
  }

  async function copyJson() {
    const payload = {
      when: new Date().toISOString(),
      pathHint: window.location.host,
      tests: results,
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

  const ready = armed && !busy && deviceReady;

  // Suppress KeyF default while armed on this view
  useEffect(() => {
    if (!active || !armed) return;
    function onKey(event: KeyboardEvent) {
      if (event.code === KEY_CODE) event.preventDefault();
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, armed]);

  return (
    <section className="card selftest-card">
      <p className="selftest-warn">
        Plug the ESP32 into <strong>this</strong> PC (the one running the browser). Keep the hit
        pad focused for keyboard tests. For click tests, also leave the system cursor over the hit
        pad. Do not type during a run. Received HID events are measured only; they are never
        re-sent to the device.
      </p>
      <div
        ref={padRef}
        id="selftest-pad"
        className={`selftest-pad${armed && !busy ? ' armed' : ''}${busy ? ' running' : ''}`}
        tabIndex={0}
        role="application"
        aria-label="Self-test hit pad"
        onClick={() => padRef.current?.focus()}
      >
        <span id="selftest-pad-label">{padLabel}</span>
      </div>
      <div className="selftest-controls">
        <label className="selftest-arm">
          <input
            type="checkbox"
            checked={armed}
            disabled={busy}
            onChange={(e) => {
              const next = e.target.checked;
              setArmed(next);
              if (next) {
                padRef.current?.focus();
                setStatus('Armed — inject tests enabled. Keep hit pad focused.');
                if (deviceReady) releaseAll();
              } else {
                abortRef.current = true;
                cancelSquareTimer();
                if (busy) {
                  releaseAll();
                  setBusy(false);
                }
                setStatus('Disarmed.');
              }
            }}
          />
          <span>Arm</span>
        </label>
        <button type="button" className="btn primary" disabled={!ready} onClick={() => void runKeyboardRtt()}>
          Keyboard RTT
        </button>
        <button type="button" className="btn ghost" disabled={!ready} onClick={() => void runClickRtt()}>
          Click RTT
        </button>
        <button type="button" className="btn ghost" disabled={!ready} onClick={() => void runBurst(100)}>
          Burst 100/s
        </button>
        <button type="button" className="btn ghost" disabled={!ready} onClick={() => void runBurst(250)}>
          Burst 250/s
        </button>
        <button type="button" className="btn ghost" disabled={!ready} onClick={() => void runSquareSmoke()}>
          Square smoke
        </button>
        <button type="button" className="btn ghost" disabled={!busy} onClick={abort}>
          Abort
        </button>
        <button type="button" className="btn ghost" disabled={results.length === 0} onClick={() => void copyJson()}>
          Copy JSON
        </button>
      </div>
      <p className="muted selftest-status" aria-live="polite">
        {status}
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
                <td colSpan={7}>No runs yet</td>
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
    </section>
  );
}
