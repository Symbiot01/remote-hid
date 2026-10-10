import { CameraPanel } from './CameraPanel.tsx';
import { HidPane } from './HidPane.tsx';
import type { LiveMode } from './useHidLink.ts';

type Tab = 'terminal' | 'camera' | 'hid';

type HidStatus = {
  configured?: boolean;
  deviceConnected?: boolean;
  error?: string;
};

type LogLine = { id: number; text: string };

type Props = {
  output: string;
  tab: Tab;
  onTab: (tab: Tab) => void;
  stream: 2 | 3;
  onStream: (stream: 2 | 3) => void;
  continuous: boolean;
  liveMode: LiveMode | null;
  onContinuous: (enabled: boolean) => void;
  source: string;
  fileName: string;
  onSender: (send: (phase: 'down' | 'up' | 'release', code?: string) => void) => void;
  hidStatus: HidStatus;
  socketOpen: boolean;
  hidLog: LogLine[];
  pushLog: (text: string) => void;
  sendFrame: (buf: ArrayBuffer | null) => boolean;
};

export function TerminalPane({
  output,
  tab,
  onTab,
  stream,
  onStream,
  continuous,
  liveMode,
  onContinuous,
  source,
  fileName,
  onSender,
  hidStatus,
  socketOpen,
  hidLog,
  pushLog,
  sendFrame,
}: Props) {

  return (
    <section className="ide-panel" aria-label="Terminal">
      <header className="ide-bar">
        <div className="ide-tabs" role="tablist" aria-label="Bottom panels">
          <button
            type="button"
            role="tab"
            className={`ide-tab${tab === 'terminal' ? ' active' : ''}`}
            aria-selected={tab === 'terminal'}
            onClick={() => onTab('terminal')}
          >
            Terminal
          </button>
          <button
            type="button"
            role="tab"
            className={`ide-tab${tab === 'camera' ? ' active' : ''}`}
            aria-selected={tab === 'camera'}
            onClick={() => onTab('camera')}
          >
            Camera
          </button>
          <button
            type="button"
            role="tab"
            className={`ide-tab${tab === 'hid' ? ' active' : ''}`}
            aria-selected={tab === 'hid'}
            onClick={() => onTab('hid')}
          >
            HID
          </button>
        </div>
      </header>
      <pre className={tab === 'terminal' ? 'ide-output' : 'ide-hidden'}>{output || 'Run has not produced output yet.'}</pre>
      <div className={tab === 'camera' ? 'ide-fill' : 'ide-hidden'}>
        <CameraPanel active={tab === 'camera'} stream={stream} onStream={onStream} />
      </div>
      <div className={tab === 'hid' ? 'ide-fill' : 'ide-hidden'}>
        <HidPane
          active={tab === 'hid'}
          continuous={continuous}
          liveMode={liveMode}
          onContinuous={onContinuous}
          source={source}
          fileName={fileName}
          onSender={onSender}
          status={hidStatus}
          socketOpen={socketOpen}
          log={hidLog}
          pushLog={pushLog}
          sendFrame={sendFrame}
        />
      </div>
    </section>
  );
}
