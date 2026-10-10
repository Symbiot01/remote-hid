import { useEffect, useRef, useState } from 'react';
import { keyFrame, releaseFrame } from './hidKeys.ts';
import type { LiveMode } from './useHidLink.ts';

type HidStatus = {
  configured?: boolean;
  deviceConnected?: boolean;
  error?: string;
};

type Progress = {
  state: string;
  sent: number;
  total: number;
  mode: string | null;
};

type LogLine = { id: number; text: string };

type Props = {
  active: boolean;
  continuous: boolean;
  liveMode: LiveMode | null;
  onContinuous: (enabled: boolean) => void;
  source: string;
  fileName: string;
  onSender: (send: (phase: 'down' | 'up' | 'release', code?: string) => void) => void;
  status: HidStatus;
  socketOpen: boolean;
  log: LogLine[];
  pushLog: (text: string) => void;
  sendFrame: (buf: ArrayBuffer | null) => boolean;
};

const MAX_CHARS = 4000;

export function HidPane({
  active,
  continuous,
  liveMode,
  onContinuous,
  source,
  fileName,
  onSender,
  status,
  socketOpen,
  log,
  pushLog,
  sendFrame,
}: Props) {
  const [wpm, setWpm] = useState(80);
  const [jitterPct, setJitterPct] = useState(25);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('Paste or send the open file. Timing stays on the relay.');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress>({ state: 'idle', sent: 0, total: 0, mode: null });
  const senderRef = useRef(onSender);
  const sendRef = useRef(sendFrame);
  const wasContinuous = useRef(false);
  senderRef.current = onSender;
  sendRef.current = sendFrame;
  const [keysSent, setKeysSent] = useState(0);

  useEffect(() => {
    senderRef.current((phase, code) => {
      if (phase === 'release') {
        sendRef.current(releaseFrame());
        return;
      }
      if (!code) return;
      const sent = sendRef.current(keyFrame(phase, code));
      if (sent && phase === 'down') setKeysSent((count) => count + 1);
    });
  }, []);

  useEffect(() => {
    if (!active || status.configured === false) return;
    const events = new EventSource('/api/hid/paste/progress');
    events.onmessage = (event) => {
      try {
        setProgress(JSON.parse(event.data) as Progress);
      } catch {
        // ignore
      }
    };
    return () => events.close();
  }, [active, status.configured]);

  useEffect(() => {
    if (wasContinuous.current && !continuous) sendFrame(releaseFrame());
    wasContinuous.current = continuous;
  }, [continuous]);

  async function sendText(text: string, label: string) {
    if (busy || text.length === 0) return;
    if (text.length > MAX_CHARS) {
      setNote(`${label} is longer than ${MAX_CHARS} characters.`);
      return;
    }
    if (!status.configured) {
      setNote('HID relay is not configured.');
      return;
    }
    if (!status.deviceConnected) {
      setNote('Keyboard is offline.');
      return;
    }
    if (continuous) onContinuous(false);
    setBusy(true);
    setNote(`Sending ${text.length} characters at ${wpm} WPM.`);
    pushLog(`${label} ${text.length} chars @ ${wpm} WPM`);
    try {
      const res = await fetch('/api/hid/paste', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, mode: 'paced', wpm, jitterPct }),
      });
      const body = (await res.json()) as { error?: string; chars?: number };
      if (!res.ok) {
        setNote(body.error || 'Paste failed');
        pushLog(body.error || 'paste failed');
        return;
      }
      setNote(`Sent ${body.chars ?? text.length} characters.`);
      if (label === 'Paste') setDraft('');
    } catch {
      setNote('Paste failed');
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    try {
      await fetch('/api/hid/paste/cancel', { method: 'POST', credentials: 'same-origin' });
    } catch {
      // the button still clears the local busy flag
    }
    setBusy(false);
    setNote('Cancelled');
    pushLog('paste cancelled');
  }

  const device = !status.configured ? 'not configured' : status.deviceConnected ? 'connected' : 'offline';

  return (
    <div className="ide-hid">
      <section className="ide-hid-debug" aria-label="HID connection">
        <p className="ide-cam-status">HID {device}</p>
        <ul className="ide-cam-checks">
          <li className={status.configured ? 'ok' : ''}>Relay: {status.configured ? 'configured' : 'not configured'}</li>
          <li className={status.deviceConnected ? 'ok' : ''}>Device: {device}</li>
          <li className={socketOpen ? 'ok' : ''}>Live socket: {socketOpen ? 'open' : 'closed'}</li>
          <li className={continuous ? 'ok' : ''}>Continuous: {continuous ? 'editor keys' : 'off'}</li>
          <li className={liveMode ? 'ok' : ''}>Live: {liveMode === 'all' ? 'all keys' : liveMode === 'typing' ? 'typing keys' : 'off'}</li>
          <li>Keys sent: {keysSent}</li>
          <li>
            Paste: {progress.state}
            {progress.total ? ` ${progress.sent}/${progress.total}` : ''}
          </li>
        </ul>
        {status.error ? <p className="ide-cam-sub">{status.error}</p> : null}
        <ol className="ide-hid-log">
          {log.map((line) => (
            <li key={line.id}>{line.text}</li>
          ))}
        </ol>
      </section>
      <section className="ide-hid-send" aria-label="Send to HID">
        <label className="ide-check">
          <input
            type="checkbox"
            checked={continuous}
            onChange={(event) => onContinuous(event.target.checked)}
          />
          Continuous — typing in the editor is sent to the keyboard
        </label>
        <p className="ide-cam-sub">Ctrl, Alt, and Meta stay in the editor. Letters, numbers, tab, and punctuation are sent.</p>
        <label className="ide-cam-field">
          WPM {wpm}
          <input type="range" min={20} max={300} step={5} value={wpm} onChange={(event) => setWpm(Number(event.target.value))} />
        </label>
        <label className="ide-cam-field">
          Jitter {jitterPct}%
          <input
            type="range"
            min={0}
            max={50}
            step={5}
            value={jitterPct}
            onChange={(event) => setJitterPct(Number(event.target.value))}
          />
        </label>
        <textarea
          className="ide-hid-draft"
          value={draft}
          maxLength={MAX_CHARS}
          placeholder="Paste text to type"
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="ide-cam-actions">
          <button type="button" className="btn primary ide-mini" disabled={busy || !draft} onClick={() => void sendText(draft, 'Paste')}>
            Send paste
          </button>
          <button
            type="button"
            className="btn ghost ide-mini"
            disabled={busy || !source}
            onClick={() => void sendText(source, fileName || 'editor')}
          >
            Send {fileName || 'file'}
          </button>
          <button type="button" className="btn ghost ide-mini" disabled={!busy && progress.state !== 'running'} onClick={() => void cancel()}>
            Cancel
          </button>
        </div>
        <p className="ide-cam-sub">{note}</p>
      </section>
    </div>
  );
}
