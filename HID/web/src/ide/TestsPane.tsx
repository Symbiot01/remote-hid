import type { TestCase } from './types.ts';

type Props = {
  cases: TestCase[];
  activeId: string;
  onSelect: (id: string) => void;
  onChange: (id: string, patch: Partial<Pick<TestCase, 'input' | 'expected'>>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
};

export function TestsPane({ cases, activeId, onSelect, onChange, onAdd, onRemove }: Props) {
  const active = cases.find((item) => item.id === activeId) ?? cases[0];

  return (
    <section className="ide-panel" aria-label="Test cases">
      <header className="ide-bar">
        <div className="ide-tabs" role="tablist" aria-label="Test cases">
          {cases.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              className={`ide-tab${item.id === active?.id ? ' active' : ''}`}
              aria-selected={item.id === active?.id}
              onClick={() => onSelect(item.id)}
            >
              Case {index + 1}
              <span className={`ide-dot ide-dot-${item.status}`} aria-hidden="true" />
            </button>
          ))}
        </div>
        <button type="button" className="btn ghost ide-mini" onClick={onAdd}>
          Add
        </button>
      </header>
      {active ? (
        <div className="ide-case">
          <div className="ide-case-head">
            <span className={`ide-result ide-result-${active.status}`}>{active.status}</span>
            {cases.length > 1 ? (
              <button type="button" className="btn ghost ide-mini" onClick={() => onRemove(active.id)}>
                Remove
              </button>
            ) : null}
          </div>
          <label className="ide-field" htmlFor="case-input">
            <span>Input</span>
            <textarea
              id="case-input"
              value={active.input}
              spellCheck={false}
              onChange={(event) => onChange(active.id, { input: event.target.value })}
            />
          </label>
          <label className="ide-field" htmlFor="case-expected">
            <span>Expected</span>
            <textarea
              id="case-expected"
              value={active.expected}
              spellCheck={false}
              onChange={(event) => onChange(active.id, { expected: event.target.value })}
            />
          </label>
          <label className="ide-field" htmlFor="case-actual">
            <span>Actual</span>
            <textarea id="case-actual" value={active.actual} readOnly spellCheck={false} />
          </label>
        </div>
      ) : null}
    </section>
  );
}
