import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type ApiError } from '../api.ts';

interface RegisterResponse {
  userId: string;
  verificationToken: string;
}

export function RegisterPage(): React.ReactElement {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [stage, setStage] = useState<'register' | 'verify'>('register');
  const [token, setToken] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const navigate = useNavigate();

  const submitRegister = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setErr(null);
    try {
      const res = await api<RegisterResponse>('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      // Phase 1.4 (no email yet): show the token so the user can verify.
      setToken(res.verificationToken);
      setStage('verify');
    } catch (caught) {
      const apiErr = caught as ApiError;
      setErr(JSON.stringify(apiErr.body));
    }
  };

  const submitVerify = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setErr(null);
    try {
      await api('/auth/verify-email', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      // Auto-login after verification.
      await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      navigate('/');
      window.location.reload();
    } catch (caught) {
      const apiErr = caught as ApiError;
      setErr(JSON.stringify(apiErr.body));
    }
  };

  return (
    <section>
      <h2>Register</h2>
      {stage === 'register' && (
        <form onSubmit={submitRegister} style={{ display: 'grid', gap: 12, maxWidth: 320 }}>
          <input
            type="email"
            placeholder="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            type="password"
            placeholder="password (min 8)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
          />
          <button type="submit">Register</button>
          {err && <span style={{ color: 'red' }}>Error: {err}</span>}
        </form>
      )}
      {stage === 'verify' && (
        <form onSubmit={submitVerify} style={{ display: 'grid', gap: 12, maxWidth: 480 }}>
          <p>
            <strong>Verification step.</strong> In production an email would be sent. For now, the
            token is below — copy/paste and submit:
          </p>
          <code
            style={{ display: 'block', padding: 12, background: '#f0f0f0', wordBreak: 'break-all' }}
          >
            {token}
          </code>
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="verification token"
          />
          <button type="submit">Verify and sign in</button>
          {err && <span style={{ color: 'red' }}>Error: {err}</span>}
        </form>
      )}
      <p>
        Already have an account? <Link to="/">Sign in</Link>
      </p>
    </section>
  );
}
