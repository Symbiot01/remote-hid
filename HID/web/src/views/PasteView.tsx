import { useEffect, useRef, useState } from 'react';

type Props = {
  deviceConnected: boolean;
  liveActive: boolean;
  active: boolean;
};

type PasteMode = 'dump' | 'paced';

const WPM_DEFAULT = 80;
const JITTER_DEFAULT = 25;
const MAX_CHARS = 4000;

type PasteProgress = {
  state: string;
  sent: number;
  total: number;
  mode: PasteMode | null;
};

export function PasteView({ deviceConnected, liveActive, active }: Props) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<PasteMode>('paced');
  const [wpm, setWpm] = useState(WPM_DEFAULT);
  const [jitterPct, setJitterPct] = useState(JITTER_DEFAULT);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<PasteProgress>({
    state: 'idle',
    sent: 0,
    total: 0,
    mode: null,
  });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!active) return;
    const events = new EventSource('/api/paste/progress');
    events.onmessage = (event) => {
      try {
        setProgress(JSON.parse(event.data) as PasteProgress);
      } catch {
        // Ignore malformed progress events.
      }
    };
    return () => events.close();
  }, [active]);

  const canSend =
    active && deviceConnected && text.length > 0 && !liveActive && !busy;
  const lineCount = Math.max(1, text.split('\n').length);

  async function sendPaste() {
    if (!canSend) return;
    setBusy(true);
    setStatus(mode === 'paced' ? 'Pacing on relay…' : 'Dumping…');
    setProgress({ state: 'running', sent: 0, total: text.length, mode });
    const ac = new AbortController();
    abortRef.current = ac;

    const body: Record<string, unknown> = { text, mode };
    if (mode === 'paced') {
      body.wpm = wpm;
      body.jitterPct = jitterPct;
    }

    try {
      const res = await fetch('/api/paste', {
        method: 'POST',
        credentials: 'same-origin',
        signal: ac.signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        chars?: number;
        sent?: number;
        total?: number;
        mode?: string;
      };
      if (res.status === 401) {
        window.location.assign('/');
        return;
      }
      if (!res.ok) {
        if (data.sent != null && data.total != null) {
          setStatus(`${data.error || 'Stopped'} — ${data.sent}/${data.total}`);
        } else {
          setStatus(data.error || 'Paste failed');
        }
        return;
      }
      setStatus(
        mode === 'paced'
          ? `Paced ${data.chars ?? text.length} chars @ ${wpm} WPM (${jitterPct}% jitter, relay timing)`
          : `Dumped ${data.chars ?? text.length} characters (no pacing)`
      );
      setText('');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setStatus('Cancelled');
      } else {
        setStatus('Paste failed');
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  async function cancelPaste() {
    abortRef.current?.abort();
    try {
      await fetch('/api/paste/cancel', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
    } catch {
      /* ignore */
    }
    setStatus('Cancelled');
    setProgress((current) => ({ ...current, state: 'cancelled' }));
    setBusy(false);
  }

  return (
    <section className="card paste-workspace">
      <header className="paste-ide-header">
        <div className="paste-file-tab" aria-label="Open document">
          <span className="paste-file-dot" aria-hidden="true" />
          <span>paste.txt</span>
          {text ? <span className="paste-file-dirty">●</span> : null}
        </div>
        <span className={`paste-connection ${deviceConnected ? 'online' : ''}`}>
          {deviceConnected ? 'Target ready' : 'Target offline'}
        </span>
      </header>

      <div className="paste-toolbar">
        <fieldset className="paste-mode" disabled={busy}>
          <legend className="sr-only">Paste mode</legend>
          <label className="radio-row">
            <input
              type="radio"
              name="paste-mode"
              checked={mode === 'paced'}
              onChange={() => setMode('paced')}
            />
            <span>Paced</span>
          </label>
          <label className="radio-row">
            <input
              type="radio"
              name="paste-mode"
              checked={mode === 'dump'}
              onChange={() => setMode('dump')}
            />
            <span>Dump</span>
          </label>
        </fieldset>

        {mode === 'paced' ? (
          <div className="paste-pace" aria-label="Relay pacing controls">
            <label className="paste-slider" htmlFor="paste-wpm">
              <span>WPM <strong>{wpm}</strong></span>
              <input
                id="paste-wpm"
                type="range"
                min={20}
                max={300}
                step={5}
                value={wpm}
                disabled={busy}
                onChange={(e) => setWpm(Number(e.target.value))}
              />
            </label>
            <label className="paste-slider" htmlFor="paste-jitter">
              <span>Jitter <strong>{jitterPct}%</strong></span>
              <input
                id="paste-jitter"
                type="range"
                min={0}
                max={50}
                step={5}
                value={jitterPct}
                disabled={busy}
                onChange={(e) => setJitterPct(Number(e.target.value))}
              />
            </label>
          </div>
        ) : null}
      </div>

      <div className="paste-editor-shell">
        <div className="paste-editor-title">
          <span>INPUT</span>
          <span className="muted">UTF-8 · {MAX_CHARS} chars max</span>
        </div>
        <label className="paste-editor" htmlFor="paste-text">
          <div className="paste-gutter" aria-hidden="true">
            {Array.from({ length: lineCount }, (_, index) => (
              <span key={index}>{index + 1}</span>
            ))}
          </div>
          <textarea
            id="paste-text"
            rows={10}
            maxLength={MAX_CHARS}
            placeholder="Paste text to type on the target…"
            spellCheck={false}
            disabled={busy}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
      </div>

      <div className="paste-statusbar">
        <span>{text.length} / {MAX_CHARS} chars</span>
        <span className="muted" aria-live="polite">
          {status}
        </span>
      </div>
      {progress.total > 0 ? (
        <div className="paste-progress" aria-live="polite">
          <div className="paste-progress__labels">
            <span>Cursor: {progress.sent} / {progress.total}</span>
            <span>{Math.max(0, progress.total - progress.sent)} remaining</span>
          </div>
          <progress
            max={progress.total}
            value={Math.min(progress.sent, progress.total)}
            aria-label="Paste progress"
          />
        </div>
      ) : null}
      <div className="actions paste-actions">
        <button
          type="button"
          className="btn primary"
          disabled={!canSend}
          onClick={() => void sendPaste()}
        >
          {busy ? 'Sending…' : 'Send'}
        </button>
        {busy ? (
          <button type="button" className="btn" onClick={() => void cancelPaste()}>
            Cancel
          </button>
        ) : (
          <span className="hint muted">{liveActive ? 'Live keys active' : 'Ready'}</span>
        )}
      </div>
    </section>
  );
}
