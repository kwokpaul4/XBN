/**
 * Buyer-side PO list. Shows the active org's outbox of POs with status,
 * counterparty, and a deep-link to detail.
 */

import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.ts';

interface PoRow {
  id: string;
  documentNumber: string;
  documentType: string;
  status: string;
  recipientOrgId: string;
  createdAt: string;
}

interface ListResponse {
  documents: PoRow[];
  total: number;
}

export function BuyerPoListPage(): React.ReactElement {
  const [rows, setRows] = useState<PoRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<ListResponse>('/documents?box=outbox&documentType=PO')
      .then((r) => setRows(r.documents))
      .catch((e: unknown) => setErr(JSON.stringify(e)));
  }, []);

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
        <h2 style={{ margin: 0 }}>My Purchase Orders</h2>
        <Link to="/buyer/po/new">+ New PO</Link>
      </div>
      {err && <p style={{ color: 'red' }}>Error: {err}</p>}
      {rows.length === 0 && <p>(no POs yet — click "+ New PO")</p>}
      <table style={{ width: '100%', marginTop: 16, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: '#f4f4f4' }}>
            <th style={th}>Number</th>
            <th style={th}>Status</th>
            <th style={th}>Recipient</th>
            <th style={th}>Created</th>
            <th style={th}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td style={td}>{r.documentNumber}</td>
              <td style={td}>
                <StatusBadge status={r.status} />
              </td>
              <td style={td}>
                <code>{r.recipientOrgId.slice(0, 12)}…</code>
              </td>
              <td style={td}>{new Date(r.createdAt).toLocaleString()}</td>
              <td style={td}>
                <Link to={`/buyer/po/${r.id}`}>View</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function StatusBadge({ status }: { status: string }): React.ReactElement {
  const colors: Record<string, string> = {
    DRAFT: '#aaa',
    ISSUED: '#3b82f6',
    ACKNOWLEDGED: '#10b981',
    IN_FULFILLMENT: '#f59e0b',
    CLOSED: '#6b7280',
    CANCELLED: '#ef4444',
    CHANGED: '#8b5cf6',
  };
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 4,
        fontSize: 12,
        background: colors[status] ?? '#999',
        color: 'white',
      }}
    >
      {status}
    </span>
  );
}

const th: React.CSSProperties = { textAlign: 'left', padding: 8, borderBottom: '1px solid #ddd' };
const td: React.CSSProperties = { padding: 8, borderBottom: '1px solid #eee' };
