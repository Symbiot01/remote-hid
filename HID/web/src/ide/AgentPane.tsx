import { useState, type FormEvent } from 'react';
import type { AgentMessage, AgentMode } from './types.ts';

type Props = {
  mode: AgentMode;
  messages: AgentMessage[];
  onMode: (mode: AgentMode) => void;
  onSend: (text: string) => void;
};

export function AgentPane({ mode, messages, onMode, onSend }: Props) {
  const [draft, setDraft] = useState('');

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft('');
  }

  return (
    <section className="ide-panel" aria-label="Agent">
      <header className="ide-bar">
        <div className="ide-modes" role="radiogroup" aria-label="Agent mode">
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'ask'}
            className={`ide-tab${mode === 'ask' ? ' active' : ''}`}
            onClick={() => onMode('ask')}
          >
            Ask
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'agent'}
            className={`ide-tab${mode === 'agent' ? ' active' : ''}`}
            onClick={() => onMode('agent')}
          >
            Agent
          </button>
        </div>
      </header>
      <ol className="ide-feed">
        {messages.length === 0 ? (
          <li className="muted ide-empty">
            {mode === 'ask'
              ? 'Ask about the open file.'
              : 'Agent will read the problem and the test cases once it is connected.'}
          </li>
        ) : (
          messages.map((message) => (
            <li key={message.id} className={`ide-msg ide-msg-${message.role}`}>
              <span className="ide-msg-role">{message.role === 'user' ? 'You' : 'Console'}</span>
              <p>{message.text}</p>
            </li>
          ))
        )}
      </ol>
      <form className="ide-compose" onSubmit={submit}>
        <label className="sr-only" htmlFor="agent-draft">
          Message
        </label>
        <textarea
          id="agent-draft"
          rows={3}
          value={draft}
          placeholder={mode === 'ask' ? 'Ask about this code' : 'Describe the problem'}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="btn primary ide-mini" disabled={draft.trim().length === 0}>
          Send
        </button>
      </form>
    </section>
  );
}
