import React from 'react';
import { Link, Outlet, useNavigate } from 'react-router-dom';
import { api } from './api.ts';
import { switchOrg, useMe } from './auth-state.ts';

export function Layout(): React.ReactElement {
  const { me, loading, refresh } = useMe();
  const navigate = useNavigate();

  if (loading) return <div style={pad}>Loading…</div>;

  if (!me) {
    // Unauthenticated — render outlet (login/register pages) with no chrome.
    return (
      <div style={pad}>
        <h1>XBN</h1>
        <p>Buyer–Supplier document-exchange network.</p>
        <Outlet />
      </div>
    );
  }

  const handleLogout = async (): Promise<void> => {
    await api('/auth/logout', { method: 'POST' });
    refresh();
    navigate('/');
  };

  return (
    <div style={pad}>
      <header style={headerStyle}>
        <h1 style={{ margin: 0 }}>XBN</h1>
        <nav style={{ display: 'flex', gap: 16 }}>
          <Link to="/buyer">Buyer</Link>
          <Link to="/supplier">Supplier</Link>
          <Link to="/admin">Admin</Link>
        </nav>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center' }}>
          <span>{me.user.email}</span>
          {me.memberships.length > 0 && (
            <select
              value={me.activeMembership?.orgId ?? ''}
              onChange={(e) => switchOrg(e.target.value)}
              aria-label="Active org"
            >
              {me.memberships.map((m) => (
                <option key={m.orgId} value={m.orgId}>
                  {m.role}
                </option>
              ))}
            </select>
          )}
          <button onClick={handleLogout}>Sign out</button>
        </div>
      </header>
      <main style={{ marginTop: 24 }}>
        <Outlet />
      </main>
    </div>
  );
}

const pad: React.CSSProperties = {
  fontFamily: 'system-ui, sans-serif',
  padding: 24,
  maxWidth: 1100,
  margin: '0 auto',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  gap: 24,
  alignItems: 'center',
  borderBottom: '1px solid #ccc',
  paddingBottom: 12,
};
