import { useNavigate } from 'react-router-dom';
import { useEffect, useState, type FormEvent } from 'react';

export function OpeningPage() {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/session', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          navigate('/app', { replace: true });
          return;
        }
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ password }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error || 'Invalid password');
        setBusy(false);
        return;
      }
      navigate('/app', { replace: true });
    } catch {
      setError('Login failed');
      setBusy(false);
    }
  }

  if (!ready) {
    return (
      <main className="shell narrow">
        <p className="muted">Checking session</p>
      </main>
    );
  }

  return (
    <main className="shell narrow">
      <header className="topbar">
        <div>
          <h1>Operator Console</h1>
          <p className="muted">Sign in to open the console.</p>
        </div>
      </header>
      <section className="card">
        <form className="login-form" onSubmit={onSubmit} autoComplete="current-password">
          <label className="field" htmlFor="password">
            <span>Password</span>
            <div className="password-field">
              <input
                id="password"
                name="password"
                className="password-field__input"
                type={showPassword ? 'text' : 'password'}
                required
                minLength={16}
                autoComplete="current-password"
                spellCheck={false}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                type="button"
                className="password-field__toggle"
                aria-pressed={showPassword}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                onClick={() => setShowPassword((value) => !value)}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </label>
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" className="btn primary" disabled={busy}>
            Sign in
          </button>
        </form>
      </section>
    </main>
  );
}
