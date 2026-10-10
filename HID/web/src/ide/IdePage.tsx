import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentPane } from './AgentPane.tsx';
import { EditorPane } from './EditorPane.tsx';
import './monacoSetup.ts';
import { SplitPane } from './SplitPane.tsx';
import { TerminalPane } from './TerminalPane.tsx';
import { TestsPane } from './TestsPane.tsx';
import { INITIAL_MAIN, type AgentMessage, type AgentMode, type EditorTab, type TestCase } from './types.ts';
import { useHidLink, type LiveMode } from './useHidLink.ts';

function nextId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

const STARTER_TABS: EditorTab[] = [
  { id: 'main', name: 'main.cpp', value: INITIAL_MAIN, dirty: false },
];

type RunCase = {
  status: 'pass' | 'fail' | 'idle';
  actual: string;
  stderr?: string;
  timeMs: number;
  reason: 'timeout' | 'output_limit' | 'runtime' | null;
  exitCode?: number | null;
};

type ProgramResult = {
  stdout: string;
  stderr: string;
  timeMs: number;
  reason: 'timeout' | 'output_limit' | 'runtime' | null;
  exitCode: number | null;
};

type RunResponse = {
  status: 'ran' | 'compile_error';
  compile: { ok: boolean; stderr: string };
  program?: ProgramResult | null;
  cases: RunCase[];
};

function formatProgram(program: ProgramResult): string {
  const lines = ['$ ./main'];
  if (program.stdout.length > 0) lines.push(program.stdout.replace(/\n$/, ''));
  if (program.stderr.trim().length > 0) lines.push(program.stderr.trim());
  if (program.reason === 'timeout') lines.push('time limit');
  else if (program.reason === 'output_limit') lines.push('output limit');
  else if (program.reason === 'runtime') lines.push(`exited ${program.exitCode ?? '?'}`);
  else lines.push(`exit ${program.exitCode ?? 0}  ${program.timeMs}ms`);
  return lines.join('\n');
}

function formatCases(payload: RunResponse): string[] {
  return payload.cases.map((item, index) => {
    if (payload.status === 'compile_error') return `case ${index + 1}  idle`;
    const detail =
      item.reason === 'timeout'
        ? 'time limit'
        : item.reason === 'output_limit'
          ? 'output limit'
          : item.reason === 'runtime'
            ? `exited ${item.exitCode ?? '?'}`
            : item.status;
    const stderr = item.stderr?.trim() ? `\n${item.stderr.trim()}` : '';
    return `case ${index + 1}  ${detail}  ${item.timeMs}ms${stderr}`;
  });
}

const STARTER_CASES: TestCase[] = [
  { id: 'case-1', input: '2 3\n', expected: '5\n', actual: '', status: 'idle' },
  { id: 'case-2', input: '10 7\n', expected: '3\n', actual: '', status: 'idle' },
];

type Props = {
  busy: boolean;
  onLogout: () => void;
};

export function IdePage({ busy, onLogout }: Props) {
  const [leftRatio, setLeftRatio] = useState(34);
  const [sideRatio, setSideRatio] = useState(58);
  const [editorRatio, setEditorRatio] = useState(68);
  const [tabs, setTabs] = useState<EditorTab[]>(STARTER_TABS);
  const [activeTabId, setActiveTabId] = useState(STARTER_TABS[0].id);
  const [cases, setCases] = useState<TestCase[]>(STARTER_CASES);
  const [activeCaseId, setActiveCaseId] = useState(STARTER_CASES[0].id);
  const [output, setOutput] = useState('');
  const [mode, setMode] = useState<AgentMode>('ask');
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [running, setRunning] = useState<'program' | 'tests' | null>(null);
  const [editorView, setEditorView] = useState<'editor' | 'stream'>('editor');
  const [cameraStream, setCameraStream] = useState<2 | 3>(2);
  const [hidContinuous, setHidContinuous] = useState(false);
  const [bottomTab, setBottomTab] = useState<'terminal' | 'camera' | 'hid'>('terminal');
  const [liveMode, setLiveMode] = useState<LiveMode | null>(null);
  const [snapNote, setSnapNote] = useState('');
  const hid = useHidLink({
    connect: bottomTab === 'hid' || hidContinuous || liveMode !== null,
    watch: bottomTab === 'hid' || hidContinuous || liveMode !== null,
    liveMode,
  });
  const hidSend = useRef<(phase: 'down' | 'up' | 'release', code?: string) => void>(() => {});
  const bindHid = useCallback((send: (phase: 'down' | 'up' | 'release', code?: string) => void) => {
    hidSend.current = send;
  }, []);
  const menuRef = useRef<HTMLDivElement>(null);
  const runSeq = useRef(0);

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
        setConfirmLogout(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        setConfirmLogout(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  function updateTab(id: string, value: string) {
    setTabs((prev) =>
      prev.map((tab) => (tab.id === id ? { ...tab, value, dirty: value !== INITIAL_MAIN } : tab)),
    );
  }

  function reorder(from: number, to: number) {
    setTabs((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      if (!moved) return prev;
      next.splice(to, 0, moved);
      return next;
    });
  }

  function addTab() {
    const id = nextId('file');
    const tab: EditorTab = {
      id,
      name: `file-${tabs.length + 1}.cpp`,
      value: INITIAL_MAIN,
      dirty: false,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(id);
  }

  function closeTab(id: string) {
    const remaining = tabs.filter((tab) => tab.id !== id);
    if (remaining.length === 0 || remaining.length === tabs.length) return;
    setTabs(remaining);
    if (activeTabId === id) setActiveTabId(remaining[0].id);
  }

  async function run(kind: 'program' | 'tests') {
    if (running) return;
    const active = tabs.find((tab) => tab.id === activeTabId);
    const source = active?.value ?? '';
    const fileName = active?.name ?? 'main.cpp';
    const submitted = cases.map((item) => ({ id: item.id, input: item.input, expected: item.expected }));
    const seq = runSeq.current + 1;
    runSeq.current = seq;
    setRunning(kind);
    const header = `$ g++ -std=c++17 -O2 -pipe -Wall -Wextra -o main ${fileName}`;
    setOutput((prev) => (prev ? `${prev}\n${header}\n` : `${header}\n`));
    try {
      const response = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          kind === 'program'
            ? { source, mode: 'program' }
            : {
                source,
                mode: 'tests',
                cases: submitted.map((item) => ({ input: item.input, expected: item.expected })),
              },
        ),
      });
      const payload = (await response.json()) as RunResponse | { error?: string };
      if (seq !== runSeq.current) return;
      if (!response.ok || !('status' in payload)) {
        const message = 'error' in payload && payload.error ? payload.error : `Run failed (${response.status})`;
        setOutput((prev) => `${prev}${message}\n`);
        return;
      }
      if (kind === 'program') {
        const lines = [payload.compile.stderr, payload.program ? formatProgram(payload.program) : ''].filter(
          (line) => line.length > 0,
        );
        setOutput((prev) => `${prev}${lines.join('\n')}\n`);
        return;
      }
      const lines = [payload.compile.stderr, ...formatCases(payload)].filter((line) => line.length > 0);
      setOutput((prev) => `${prev}${lines.join('\n')}\n`);
      if (payload.status === 'compile_error') {
        setCases((prev) => prev.map((item) => ({ ...item, status: 'idle', actual: '' })));
        return;
      }
      setCases((prev) =>
        prev.map((item, index) => {
          const result = payload.cases[index];
          if (!result || submitted[index]?.id !== item.id) return item;
          return { ...item, status: result.status, actual: result.actual };
        }),
      );
    } catch {
      if (seq !== runSeq.current) return;
      setOutput((prev) => `${prev}Runner is unreachable.\n`);
    } finally {
      if (seq === runSeq.current) setRunning(null);
    }
  }

  function enterLive(mode: LiveMode) {
    setHidContinuous(false);
    setEditorView('stream');
    setLiveMode(mode);
    setSnapNote('');
  }

  function leaveLive() {
    setLiveMode(null);
  }

  function showView(next: 'editor' | 'stream') {
    setEditorView(next);
    if (next !== 'stream') setLiveMode(null);
  }

  async function snap(kind: 'frame' | 'agent') {
    setSnapNote(kind === 'frame' ? 'Saving frame…' : 'Asking the capture agent…');
    try {
      const response = await fetch(kind === 'frame' ? '/api/capture/frame' : '/api/capture/snap', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setSnapNote(body.error || 'Snap failed');
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = kind === 'frame' ? 'frame.jpg' : 'capture.jpg';
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
      setSnapNote(kind === 'frame' ? 'Saved frame.jpg' : 'Saved capture.jpg');
    } catch {
      setSnapNote('Snap failed');
    }
  }

  function send(text: string) {
    const reply =
      mode === 'ask'
        ? 'Ask is not connected yet. The open file stays unchanged.'
        : 'Agent is not connected yet. Test cases and the editor stay unchanged.';
    setMessages((prev) => [
      ...prev,
      { id: nextId('msg'), role: 'user', text },
      { id: nextId('msg'), role: 'assistant', text: reply },
    ]);
  }

  return (
    <div className="ide-app">
      <header className="ide-top">
        <strong>Operator</strong>
        <span className="muted">IDE</span>
        <div className="ide-menu" ref={menuRef}>
          <button
            type="button"
            className="btn ghost ide-mini"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={() => {
              setMenuOpen((open) => !open);
              setConfirmLogout(false);
            }}
          >
            Menu
          </button>
          {menuOpen ? (
            <div className="ide-menu-panel" role="menu">
              {confirmLogout ? (
                <>
                  <p className="ide-menu-note">Everything here will be lost</p>
                  <button
                    type="button"
                    role="menuitem"
                    className="btn danger ide-mini"
                    disabled={busy}
                    onClick={onLogout}
                  >
                    Logout
                  </button>
                  <button
                    type="button"
                    className="btn ghost ide-mini"
                    disabled={busy}
                    onClick={() => setConfirmLogout(false)}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  className="ide-menu-item"
                  onClick={() => setConfirmLogout(true)}
                >
                  Logout
                </button>
              )}
            </div>
          ) : null}
        </div>
      </header>
      <SplitPane
        direction="row"
        ratio={leftRatio}
        min={22}
        max={48}
        onRatio={setLeftRatio}
        label="Resize side panels and editor"
        first={
          <SplitPane
            direction="column"
            ratio={sideRatio}
            min={28}
            max={78}
            onRatio={setSideRatio}
            label="Resize agent and test cases"
            first={<AgentPane mode={mode} messages={messages} onMode={setMode} onSend={send} />}
            second={
              <TestsPane
                cases={cases}
                activeId={activeCaseId}
                onSelect={setActiveCaseId}
                onAdd={() => {
                  const id = nextId('case');
                  setCases((prev) => [...prev, { id, input: '', expected: '', actual: '', status: 'idle' }]);
                  setActiveCaseId(id);
                }}
                onRemove={(id) => {
                  const remaining = cases.filter((item) => item.id !== id);
                  if (remaining.length === 0 || remaining.length === cases.length) return;
                  setCases(remaining);
                  if (activeCaseId === id) setActiveCaseId(remaining[0].id);
                }}
                onChange={(id, patch) => {
                  setCases((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch, status: 'idle', actual: '' } : item)));
                }}
              />
            }
          />
        }
        second={
          <SplitPane
            direction="column"
            ratio={editorRatio}
            min={32}
            max={82}
            onRatio={setEditorRatio}
            label="Resize editor and terminal"
            first={
              <EditorPane
                tabs={tabs}
                activeId={activeTabId}
                onSelect={setActiveTabId}
                onChange={updateTab}
                onReorder={reorder}
                onAdd={addTab}
                onClose={closeTab}
                onRun={() => {
                  void run('program');
                }}
                onTest={() => {
                  void run('tests');
                }}
                running={running}
                view={editorView}
                onView={showView}
                stream={cameraStream}
                continuous={hidContinuous}
                onHidKey={(phase, code) => hidSend.current(phase, code)}
                liveMode={liveMode}
                onLive={enterLive}
                onLeaveLive={leaveLive}
                onSnap={(kind) => {
                  void snap(kind);
                }}
                sendFrame={hid.sendFrame}
                snapNote={snapNote}
                onClearNote={() => setSnapNote('')}
              />
            }
            second={
              <TerminalPane
                output={output}
                tab={bottomTab}
                onTab={setBottomTab}
                stream={cameraStream}
                onStream={setCameraStream}
                continuous={hidContinuous}
                liveMode={liveMode}
                onContinuous={(enabled) => {
                  if (enabled) setLiveMode(null);
                  setHidContinuous(enabled);
                }}
                source={(tabs.find((tab) => tab.id === activeTabId) ?? tabs[0])?.value ?? ''}
                fileName={(tabs.find((tab) => tab.id === activeTabId) ?? tabs[0])?.name ?? 'main.cpp'}
                onSender={bindHid}
                hidStatus={hid.status}
                socketOpen={hid.socketOpen}
                hidLog={hid.log}
                pushLog={hid.pushLog}
                sendFrame={hid.sendFrame}
              />
            }
          />
        }
      />
    </div>
  );
}
