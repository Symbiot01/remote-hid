import { useRef, useState } from 'react';

type Props = {
  deviceConnected: boolean;
  liveActive: boolean;
  active: boolean;
};

type PasteMode = 'dump' | 'paced';

const WPM_DEFAULT = 80;
const JITTER_DEFAULT = 25;

export function PasteView({ deviceConnected, liveActive, active }: Props) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<PasteMode>('paced');
  const [wpm, setWpm] = useState(WPM_DEFAULT);
  const [jitterPct, setJitterPct] = useState(JITTER_DEFAULT);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const canSend =
    active && deviceConnected && text.length > 0 && !liveActive && !busy;

  async function sendPaste() {
    if (!canSend) return;
    setBusy(true);
    setStatus(mode === 'paced' ? 'Pacing on relay…' : 'Dumping…');
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
    setBusy(false);
  }

  return (
    <section className="card">
      <p className="paste-lead muted">
        WPM and jitter are applied on the <strong>HID relay</strong> between WebSocket
        chunks. The ESP32 only prints what it receives — its USB rate is not those
        settings and can differ from the paced interval.
      </p>

      <fieldset className="paste-mode" disabled={busy}>
        <legend className="sr-only">Paste mode</legend>
        <label className="radio-row">
          <input
            type="radio"
            name="paste-mode"
            checked={mode === 'paced'}
            onChange={() => setMode('paced')}
          />
          <span>
            <strong>Paced</strong> — relay waits between characters (WPM + jitter)
          </span>
        </label>
        <label className="radio-row">
          <input
            type="radio"
            name="paste-mode"
            checked={mode === 'dump'}
            onChange={() => setMode('dump')}
          />
          <span>
            <strong>Dump</strong> — send ASAP; ESP32 <code>Keyboard.print</code> flood
          </span>
        </label>
      </fieldset>

      {mode === 'paced' ? (
        <div className="paste-pace" aria-label="Relay pacing controls">
          <label className="field" htmlFor="paste-wpm">
            <span>
              WPM (relay) — {wpm}
              <span className="hint"> · 5 chars = 1 word</span>
            </span>
            <input
              id="paste-wpm"
              type="range"
              min={20}
              max={180}
              step={5}
              value={wpm}
              disabled={busy}
              onChange={(e) => setWpm(Number(e.target.value))}
            />
          </label>
          <label className="field" htmlFor="paste-jitter">
            <span>
              Jitter (relay) — {jitterPct}%
              <span className="hint"> · random scale of interval, not WebRTC jitter</span>
            </span>
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

      <label className="field" htmlFor="paste-text">
        <span>Text to type on the target</span>
        <textarea
          id="paste-text"
          rows={8}
          maxLength={2000}
          placeholder="Paste a block to type on the target…"
          spellCheck={false}
          disabled={busy}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <div className="meta-row">
        <span className="muted">{text.length} / 2000</span>
        <span className="muted" aria-live="polite">
          {status}
        </span>
      </div>
      <div className="actions">
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
          <span className="hint muted">Disabled while live keys are on</span>
        )}
      </div>
    </section>
  );
}
