import Editor, { type OnMount } from '@monaco-editor/react';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { releaseFrame } from './hidKeys.ts';
import { StreamPane } from './StreamPane.tsx';
import type { EditorTab } from './types.ts';
import type { LiveMode } from './useHidLink.ts';

type Props = {
  tabs: EditorTab[];
  activeId: string;
  onSelect: (id: string) => void;
  onChange: (id: string, value: string) => void;
  onReorder: (from: number, to: number) => void;
  onAdd: () => void;
  onClose: (id: string) => void;
  onRun: () => void;
  onTest: () => void;
  running: 'program' | 'tests' | null;
  view: 'editor' | 'stream';
  onView: (view: 'editor' | 'stream') => void;
  stream: 2 | 3;
  continuous: boolean;
  onHidKey: (phase: 'down' | 'up', code: string) => void;
  liveMode: LiveMode | null;
  onLive: (mode: LiveMode) => void;
  onLeaveLive: () => void;
  onSnap: (kind: 'frame' | 'agent') => void;
  sendFrame: (buf: ArrayBuffer | null) => boolean;
  snapNote: string;
  onClearNote: () => void;
};

export function EditorPane({
  tabs,
  activeId,
  onSelect,
  onChange,
  onReorder,
  onAdd,
  onClose,
  onRun,
  onTest,
  running,
  view,
  onView,
  stream,
  continuous,
  onHidKey,
  liveMode,
  onLive,
  onLeaveLive,
  onSnap,
  sendFrame,
  snapNote,
  onClearNote,
}: Props) {
  const stripRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const dragFrom = useRef<number | null>(null);
  const continuousRef = useRef(continuous);
  const viewRef = useRef(view);
  const hidRef = useRef(onHidKey);
  continuousRef.current = continuous;
  viewRef.current = view;
  hidRef.current = onHidKey;
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];

  const onMount: OnMount = (editor) => {
    const forward = (phase: 'down' | 'up', event: KeyboardEvent) => {
      if (!continuousRef.current || viewRef.current !== 'editor') return;
      if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
      hidRef.current(phase, event.code);
    };
    const down = editor.onKeyDown((event) => forward('down', event.browserEvent));
    const up = editor.onKeyUp((event) => forward('up', event.browserEvent));
    editor.onDidDispose(() => {
      down.dispose();
      up.dispose();
    });
  };

  function reorderFromPoint(clientX: number) {
    const strip = stripRef.current;
    const from = dragFrom.current;
    if (!strip || from === null) return;
    const buttons = [...strip.querySelectorAll<HTMLElement>('[data-tab]')];
    let to = buttons.length - 1;
    for (let index = 0; index < buttons.length; index += 1) {
      const rect = buttons[index].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) {
        to = index;
        break;
      }
    }
    if (to !== from) {
      onReorder(from, to);
      dragFrom.current = to;
    }
  }

  function closeMenu() {
    if (liveMode) sendFrame(releaseFrame());
    setMenu(null);
  }
  const closeMenuRef = useRef(closeMenu);
  closeMenuRef.current = closeMenu;

  useEffect(() => {
    if (!menu) return;
    function onPointerDown(event: Event) {
      if (!menuRef.current?.contains(event.target as Node)) closeMenuRef.current();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeMenuRef.current();
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [menu]);

  function onTabPointerDown(event: PointerEvent<HTMLButtonElement>, index: number) {
    dragFrom.current = index;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  return (
    <section className="ide-panel" aria-label="Editor">
      <header className="ide-bar">
        <div
          ref={stripRef}
          className="ide-tabs"
          role="tablist"
          aria-label="Open files"
          onPointerMove={(event) => {
            if (dragFrom.current !== null && event.buttons === 1) reorderFromPoint(event.clientX);
          }}
          onPointerUp={() => {
            dragFrom.current = null;
          }}
        >
          {tabs.map((tab, index) => (
            <div key={tab.id} className="ide-tab-wrap" data-tab="true">
              <button
                type="button"
                role="tab"
                className={`ide-tab${view === 'editor' && tab.id === active?.id ? ' active' : ''}`}
                aria-selected={view === 'editor' && tab.id === active?.id}
                onClick={() => {
                  onView('editor');
                  onSelect(tab.id);
                }}
                onPointerDown={(event) => onTabPointerDown(event, index)}
              >
                {tab.name}
                {tab.dirty ? <span className="ide-dirty">●</span> : null}
              </button>
              {tabs.length > 1 ? (
                <button
                  type="button"
                  className="ide-tab-close"
                  aria-label={`Close ${tab.name}`}
                  onClick={() => onClose(tab.id)}
                >
                  ×
                </button>
              ) : null}
            </div>
          ))}
          <button
            type="button"
            role="tab"
            className={`ide-tab${view === 'stream' ? ' active' : ''}`}
            aria-selected={view === 'stream'}
            onClick={() => onView('stream')}
            onContextMenu={(event) => {
              event.preventDefault();
              onClearNote();
              setMenu({ x: event.clientX, y: event.clientY });
            }}
          >
            Stream
          </button>
        </div>
        {menu ? (
          <div
            ref={menuRef}
            className="ide-menu-panel ide-stream-menu"
            role="menu"
            style={{ left: menu.x, top: menu.y }}
          >
            <button
              type="button"
              role="menuitem"
              className="ide-menu-item"
              onClick={() => {
                closeMenu();
                onLive('typing');
              }}
            >
              Live, typing keys
            </button>
            <button
              type="button"
              role="menuitem"
              className="ide-menu-item"
              onClick={() => {
                closeMenu();
                onLive('all');
              }}
            >
              Live, all keys
            </button>
            <button
              type="button"
              role="menuitem"
              className="ide-menu-item"
              disabled={!liveMode}
              onClick={() => {
                closeMenu();
                onLeaveLive();
              }}
            >
              Leave live
            </button>
            <button
              type="button"
              role="menuitem"
              className="ide-menu-item"
              onClick={() => {
                closeMenu();
                onSnap('frame');
              }}
            >
              Snap frame
            </button>
            <button
              type="button"
              role="menuitem"
              className="ide-menu-item"
              onClick={() => {
                closeMenu();
                onSnap('agent');
              }}
            >
              Snap agent
            </button>
            {snapNote && menu ? <p className="ide-menu-note">{snapNote}</p> : null}
          </div>
        ) : null}
        {snapNote && !menu ? <p className="ide-snap-note">{snapNote}</p> : null}
        <div className="ide-bar-actions">
          <button type="button" className="btn ghost ide-mini" onClick={onAdd}>
            New tab
          </button>
          <button type="button" className="btn primary ide-mini" onClick={onRun} disabled={running !== null}>
            {running === 'program' ? 'Running' : 'Run'}
          </button>
          <button type="button" className="btn ghost ide-mini" onClick={onTest} disabled={running !== null}>
            {running === 'tests' ? 'Testing' : 'Test'}
          </button>
        </div>
      </header>
      <div className="ide-stage">
        <div className={view === 'stream' ? 'ide-fill' : 'ide-hidden'}>
          <StreamPane
            active={view === 'stream'}
            stream={stream}
            liveMode={liveMode}
            onLeave={onLeaveLive}
            sendFrame={sendFrame}
          />
        </div>
        <div className={view === 'stream' ? 'ide-hidden' : 'ide-fill'}>
        {active ? (
          <Editor
            key={active.id}
            height="100%"
            language="cpp"
            theme="vs-dark"
            value={active.value}
            onChange={(next) => onChange(active.id, next ?? '')}
            onMount={onMount}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              padding: { top: 8 },
            }}
          />
        ) : null}
        </div>
      </div>
    </section>
  );
}
