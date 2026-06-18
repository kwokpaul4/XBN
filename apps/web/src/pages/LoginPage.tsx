import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type ApiError } from '../api.ts';

export function LoginPage(): React.ReactElement {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const navigate = useNavigate();

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setErr(null);
    try {
      await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      navigate('/');
      window.location.reload();
    } catch (caught) {
      const apiErr = caught as ApiError;
      const reason =
        typeof apiErr.body === 'object' && apiErr.body !== null && 'error' in apiErr.body
          ? String((apiErr.body as { error: unknown }).error)
          : 'login_failed';
      setErr(reason);
    }
  };

  return (
    <section>
      <h2>Sign in</h2>
      <form onSubmit={submit} style={{ display: 'grid', gap: 12, maxWidth: 320 }}>
        <input
          type="email"
          placeholder="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button type="submit">Sign in</button>
        {err && <span style={{ color: 'red' }}>Error: {err}</span>}
      </form>
      <p>
        New here? <Link to="/register">Register</Link>
      </p>
    </section>
  );
}
