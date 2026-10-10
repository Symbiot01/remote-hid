import { useRef, type PointerEvent, type ReactNode } from 'react';

type Props = {
  direction: 'row' | 'column';
  ratio: number;
  min: number;
  max: number;
  onRatio: (next: number) => void;
  first: ReactNode;
  second: ReactNode;
  label: string;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function SplitPane({ direction, ratio, min, max, onRatio, first, second, label }: Props) {
  const frameRef = useRef<HTMLDivElement>(null);
  const axis = direction === 'row' ? 'column' : 'row';
  const style =
    direction === 'row'
      ? { gridTemplateColumns: `minmax(0, ${ratio}fr) 4px minmax(0, ${100 - ratio}fr)` }
      : { gridTemplateRows: `minmax(0, ${ratio}fr) 4px minmax(0, ${100 - ratio}fr)` };

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    const frame = frameRef.current;
    if (!frame) return;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const move = (ev: globalThis.PointerEvent) => {
      const rect = frame.getBoundingClientRect();
      const span = direction === 'row' ? rect.width : rect.height;
      const offset = direction === 'row' ? ev.clientX - rect.left : ev.clientY - rect.top;
      if (span <= 0) return;
      onRatio(clamp((offset / span) * 100, min, max));
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  }

  return (
    <div ref={frameRef} className={`split split-${direction}`} style={style}>
      <div className="split-pane">{first}</div>
      <div
        className={`split-handle split-handle-${direction}`}
        role="separator"
        aria-orientation={axis === 'column' ? 'vertical' : 'horizontal'}
        aria-valuenow={Math.round(ratio)}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-label={label}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onKeyDown={(event) => {
          const step = event.key.endsWith('Left') || event.key.endsWith('Up') ? -2 : 0;
          const forward = event.key.endsWith('Right') || event.key.endsWith('Down') ? 2 : 0;
          if (step || forward) onRatio(clamp(ratio + step + forward, min, max));
        }}
      />
      <div className="split-pane">{second}</div>
    </div>
  );
}
