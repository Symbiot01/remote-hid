import { useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { IdePage } from '../ide/IdePage.tsx';

export function SignedInPage() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/session', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          navigate('/', { replace: true });
          return;
        }
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) navigate('/', { replace: true });
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  async function logout() {
    setBusy(true);
    try {
      await fetch('/api/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
    } catch {
      // Leave the page even if the network drops. The cookie clear is best-effort.
    }
    navigate('/', { replace: true });
  }

  if (!ready) {
    return (
      <main className="ide-app">
        <p className="muted ide-check">Checking session</p>
      </main>
    );
  }

  return <IdePage busy={busy} onLogout={() => void logout()} />;
}
