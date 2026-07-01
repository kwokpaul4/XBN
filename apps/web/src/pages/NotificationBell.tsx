import React, { useEffect, useState } from 'react';
import { api } from '../api.ts';

/**
 * Phase 4.5 — Notification bell that polls the /network/notifications
 * outbox. Lightweight polling (every 30 s) — a websocket push channel is
 * Phase 5.4 work. Renders a dropdown of recent notifications; clicking one
 * marks it read.
 */

interface Notification {
  id: string;
  eventType: string;
  documentId: string | null;
  status: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

export function NotificationBell(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);

  async function refresh(): Promise<void> {
    try {
      const data = await api<{ notifications: Notification[]; unreadCount: number }>(
        '/network/notifications?limit=15',
      );
      setItems(data.notifications);
      setUnread(data.unreadCount);
    } catch {
      // Silent — the bell is decorative if the API blips.
    }
  }

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(id);
  }, []);

  async function markRead(id: string): Promise<void> {
    try {
      await api(`/network/notifications/${id}/read`, { method: 'POST' });
      await refresh();
    } catch {
      // ignore
    }
  }

  async function markAllRead(): Promise<void> {
    try {
      await api('/network/notifications/read-all', { method: 'POST' });
      await refresh();
    } catch {
      // ignore
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          position: 'relative',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
        }}
        aria-label={`Notifications (${unread} unread)`}
      >
        🔔
        {unread > 0 && (
          <span
            style={{
              position: 'absolute',
              top: -4,
              right: -8,
              background: 'crimson',
              color: 'white',
              borderRadius: 8,
              padding: '0 6px',
              fontSize: 11,
              fontWeight: 'bold',
            }}
          >
            {unread}
          </span>
        )}
      </button>
      {open && (
        <div style={dropdownStyle}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '8px 12px',
              borderBottom: '1px solid #eee',
            }}
          >
            <strong>Notifications</strong>
            {items.length > 0 && (
              <button onClick={() => void markAllRead()} style={{ fontSize: 12 }}>
                Mark all read
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <div style={{ padding: 16, color: '#666' }}>Nothing new.</div>
          ) : (
            items.map((n) => {
              const isUnread = n.status === 'PENDING';
              return (
                <div
                  key={n.id}
                  style={{
                    padding: '8px 12px',
                    borderBottom: '1px solid #f0f0f0',
                    background: isUnread ? '#fffbe6' : 'white',
                    fontSize: 13,
                    cursor: isUnread ? 'pointer' : 'default',
                  }}
                  onClick={() => isUnread && void markRead(n.id)}
                >
                  <div style={{ fontWeight: isUnread ? 'bold' : 'normal' }}>{n.eventType}</div>
                  <div style={{ color: '#666', fontSize: 11 }}>
                    {n.payload && typeof n.payload === 'object' && 'documentNumber' in n.payload
                      ? String(n.payload.documentNumber)
                      : n.documentId}
                  </div>
                  <div style={{ color: '#999', fontSize: 11 }}>
                    {new Date(n.createdAt).toLocaleString()}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

const dropdownStyle: React.CSSProperties = {
  position: 'absolute',
  top: 30,
  right: 0,
  width: 320,
  maxHeight: 400,
  overflowY: 'auto',
  background: 'white',
  border: '1px solid #ccc',
  borderRadius: 6,
  boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
  zIndex: 100,
};
