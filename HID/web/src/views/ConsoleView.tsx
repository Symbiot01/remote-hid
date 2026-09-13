import { useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useCamWhep } from '../hooks/useCamWhep';
import { useHidSocket } from '../hooks/useHidSocket';
import { useLiveHid, type ConsoleViewName } from '../hooks/useLiveHid';
import { fetchPhoto } from '../lib/fetchPhoto';
import { PasteView } from './PasteView';
import { SelfTestView } from './SelfTestView';
import { StreamTestView } from './StreamTestView';

const TABS: { id: ConsoleViewName; label: string }[] = [
  { id: 'focus', label: 'Focus' },
  { id: 'split', label: 'Split' },
  { id: 'paste', label: 'Paste' },
  { id: 'selftest', label: 'Self-test' },
  { id: 'streamtest', label: 'Stream-test' },
];

type LightboxState = { url: string; filename: string };

export function ConsoleView() {
  const navigate = useNavigate();
  const [view, setView] = useState<ConsoleViewName>('focus');
  const stageRef = useRef<HTMLDivElement>(null);
  const scratchRef = useRef<HTMLTextAreaElement>(null);
  const camVideoRef = useRef<HTMLVideoElement>(null);

  const {
    wsConnected,
    deviceConnected,
    captureConnected,
    lastError,
    clearError,
    sendBinary,
    isOpen,
  } = useHidSocket();

  const live = useLiveHid({
    view,
    deviceConnected,
    wsConnected,
    sendBinary,
    isOpen,
    stageRef,
    scratchRef,
  });

  const camActive = view === 'focus' || view === 'split';
  const cam = useCamWhep(camActive, camVideoRef);

  useEffect(() => {
    if (camActive) {
      cam.syncVideo();
    }
  }, [view, camActive, cam.status, cam.syncVideo]);

  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<LightboxState | null>(null);

  useEffect(() => {
    return () => {
      if (lightbox) {
        URL.revokeObjectURL(lightbox.url);
      }
    };
  }, [lightbox]);

  useEffect(() => {
    if (!lightbox) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        closeLightbox();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  if (lastError && live.liveActive && lastError !== 'Key not supported') {
    clearError();
  }

  function closeLightbox() {
    setLightbox((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
  }

  async function onSnapshot(e: MouseEvent) {
    e.stopPropagation();
    if (photoBusy || !captureConnected) return;
    setPhotoBusy(true);
    setPhotoError(null);
    const result = await fetchPhoto();
    setPhotoBusy(false);
    if (!result.ok) {
      setPhotoError(result.error);
      return;
    }
    setLightbox((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return {
        url: URL.createObjectURL(result.blob),
        filename: result.filename,
      };
    });
  }

  function downloadLightbox() {
    if (!lightbox) return;
    const a = document.createElement('a');
    a.href = lightbox.url;
    a.download = lightbox.filename;
    a.click();
  }

  async function logout() {
    live.stopLive();
    try {
      await fetch('/api/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
    } catch {
      // still leave
    }
    navigate('/', { replace: true });
  }

  function switchView(next: ConsoleViewName) {
    setView(next);
  }

  const stageClass =
    'video-stage' +
    (live.liveActive && (view === 'focus' || view === 'split') ? ' hid-focus' : '');

  const canSnapshot = captureConnected && !photoBusy;

  function videoChromeExtras() {
    return (
      <>
        <span className="chrome-sep" aria-hidden="true" />
        <button
          type="button"
          className="btn ghost"
          title="Reconnect MediaMTX /cam WHEP"
          onClick={(e) => {
            e.stopPropagation();
            cam.reconnect();
          }}
        >
          Reconnect video
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={!canSnapshot}
          title={
            captureConnected
              ? 'Capture still JPEG from Pi'
              : 'Capture node offline'
          }
          onClick={(e) => {
            void onSnapshot(e);
          }}
        >
          {photoBusy ? 'Snapshot…' : 'Snapshot'}
        </button>
      </>
    );
  }

  function mouseChrome() {
    return (
      <>
        <span className="chrome-sep" aria-hidden="true" />
        <button
          type="button"
          className="btn ghost"
          disabled={!live.canMouseTest}
          title="Move target cursor in a square"
          onClick={(e) => {
            e.stopPropagation();
            live.runMouseSquare();
          }}
        >
          Square
        </button>
        <button
          type="button"
          className="btn ghost btn-icon"
          disabled={!live.canMouseTest}
          title="Nudge up"
          onClick={(e) => {
            e.stopPropagation();
            live.nudgeMouse(0, -80);
          }}
        >
          ↑
        </button>
        <button
          type="button"
          className="btn ghost btn-icon"
          disabled={!live.canMouseTest}
          title="Nudge left"
          onClick={(e) => {
            e.stopPropagation();
            live.nudgeMouse(-80, 0);
          }}
        >
          ←
        </button>
        <button
          type="button"
          className="btn ghost btn-icon"
          disabled={!live.canMouseTest}
          title="Nudge down"
          onClick={(e) => {
            e.stopPropagation();
            live.nudgeMouse(0, 80);
          }}
        >
          ↓
        </button>
        <button
          type="button"
          className="btn ghost btn-icon"
          disabled={!live.canMouseTest}
          title="Nudge right"
          onClick={(e) => {
            e.stopPropagation();
            live.nudgeMouse(80, 0);
          }}
        >
          →
        </button>
      </>
    );
  }

  function stageBody(hint: string) {
    return (
      <>
        <video
          ref={camVideoRef}
          className="cam-video"
          playsInline
          muted
          autoPlay
        />
        {cam.status !== 'live' ? (
          <div className="video-placeholder cam-overlay" aria-hidden="true">
            <span>{cam.status === 'connecting' ? 'Connecting to /cam…' : 'No live video'}</span>
            <span className="muted">{hint}</span>
          </div>
        ) : null}
        <div className="video-chrome">
          <button
            type="button"
            className="btn primary"
            disabled={!live.canLive}
            onClick={(e) => {
              e.stopPropagation();
              void live.startLive();
            }}
          >
            Start live
          </button>
          <button
            type="button"
            className="btn ghost"
            disabled={!live.liveActive}
            onClick={(e) => {
              e.stopPropagation();
              live.stopLive('Live keys off');
            }}
          >
            Stop
          </button>
          {videoChromeExtras()}
          {mouseChrome()}
          <span className="hint muted">{cam.videoLabel}</span>
          <span className="hint muted">{live.hint}</span>
        </div>
      </>
    );
  }

  return (
    <main className="shell wide">
      <header className="topbar">
        <div>
          <h1>Operator Console</h1>
          <p className="muted">
            Live video is MediaMTX <code>/cam</code> (WHEP). Keys/mouse go to the ESP32.
            Snapshot stills use capture WS (briefly pauses SRT on the Pi).
          </p>
        </div>
        <div className="topbar-actions">
          <div className="status-row compact">
            <span className="label">Device</span>
            <span
              className={`badge ${deviceConnected ? 'online' : 'offline'}`}
              aria-live="polite"
            >
              {deviceConnected ? 'Connected' : 'Disconnected'}
            </span>
            <span className="label">Capture</span>
            <span
              className={`badge ${captureConnected ? 'online' : 'offline'}`}
              aria-live="polite"
            >
              {captureConnected ? 'Online' : 'Offline'}
            </span>
            <span className="label">Video</span>
            <span
              className={`badge ${
                cam.status === 'live'
                  ? 'online'
                  : cam.status === 'connecting'
                    ? 'live'
                    : 'offline'
              }`}
              aria-live="polite"
            >
              {cam.status === 'live'
                ? 'Live'
                : cam.status === 'connecting'
                  ? 'Connecting'
                  : 'Off'}
            </span>
            <span className={`badge ${wsConnected ? 'online' : 'muted-badge'}`} aria-live="polite">
              {wsConnected ? 'WS connected' : 'WS disconnected'}
            </span>
            <span className={`badge ${live.liveActive ? 'live' : 'muted-badge'}`}>
              {live.liveActive ? 'HID live' : 'HID idle'}
            </span>
          </div>
          <button type="button" className="btn ghost" onClick={() => void logout()}>
            Logout
          </button>
        </div>
      </header>

      <nav className="view-tabs" role="tablist" aria-label="Views">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`tab${view === tab.id ? ' active' : ''}`}
            role="tab"
            aria-selected={view === tab.id}
            onClick={() => switchView(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {view === 'focus' ? (
        <section className="view active">
          <div
            ref={stageRef}
            className={stageClass}
            tabIndex={0}
            onClick={live.onStageClick}
          >
            {stageBody('Click stage, then Start live (keys + mouse)')}
          </div>
          <p className="muted live-last">{photoError || live.lastKey}</p>
        </section>
      ) : null}

      {view === 'split' ? (
        <section className="view active">
          <div className="split-grid">
            <div
              ref={stageRef}
              className={stageClass}
              tabIndex={0}
              onClick={live.onStageClick}
            >
              {stageBody('Focus this pane for keys + mouse')}
            </div>
            <div className="scratch-pane">
              <label className="field" htmlFor="scratch">
                <span>Scratch notes (while live, keystrokes still go to HID)</span>
                <textarea
                  id="scratch"
                  ref={scratchRef}
                  rows={16}
                  placeholder="Local notes — typing while live is forwarded to the target…"
                  spellCheck={false}
                  onFocus={live.onScratchFocus}
                />
              </label>
            </div>
          </div>
          <p className="muted live-last">{photoError || live.lastKey}</p>
          <p className="hint muted">{live.hint}</p>
        </section>
      ) : null}

      {view === 'paste' ? (
        <PasteView
          deviceConnected={deviceConnected}
          liveActive={live.liveActive}
          active={view === 'paste'}
        />
      ) : null}

      {view === 'selftest' ? (
        <SelfTestView
          deviceReady={deviceConnected && wsConnected}
          sendBinary={sendBinary}
          active={view === 'selftest'}
        />
      ) : null}

      {view === 'streamtest' ? <StreamTestView active={view === 'streamtest'} /> : null}

      {lightbox ? (
        <div
          className="photo-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="Capture snapshot"
          onClick={closeLightbox}
        >
          <div
            className="photo-lightbox-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <img src={lightbox.url} alt={lightbox.filename} />
            <div className="photo-lightbox-actions">
              <span className="muted">{lightbox.filename}</span>
              <button type="button" className="btn ghost" onClick={downloadLightbox}>
                Download
              </button>
              <button type="button" className="btn primary" onClick={closeLightbox}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
