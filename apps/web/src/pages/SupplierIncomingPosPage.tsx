/**
 * Supplier-side incoming-POs list. Shows POs where the active org is the
 * recipient.
 */

import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.ts';

interface PoRow {
  id: string;
  documentNumber: string;
  status: string;
  issuerOrgId: string;
  createdAt: string;
}

interface ListResponse {
  documents: PoRow[];
  total: number;
}

export function SupplierIncomingPosPage(): React.ReactElement {
  const [rows, setRows] = useState<PoRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<ListResponse>('/documents?box=inbox&documentType=PO')
      .then((r) => setRows(r.documents))
      .catch((e: unknown) => setErr(JSON.stringify(e)));
  }, []);

  return (
    <section>
      <h2>Incoming Purchase Orders</h2>
      {err && <p style={{ color: 'red' }}>Error: {err}</p>}
      {rows.length === 0 && <p>(no incoming POs)</p>}
      <table style={{ width: '100%', marginTop: 16, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: '#f4f4f4' }}>
            <th style={th}>Number</th>
            <th style={th}>Status</th>
            <th style={th}>From buyer</th>
            <th style={th}>Received</th>
            <th style={th}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td style={td}>{r.documentNumber}</td>
              <td style={td}>{r.status}</td>
              <td style={td}>
                <code>{r.issuerOrgId.slice(0, 12)}…</code>
              </td>
              <td style={td}>{new Date(r.createdAt).toLocaleString()}</td>
              <td style={td}>
                <Link to={`/supplier/po/${r.id}`}>View</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

const th: React.CSSProperties = { textAlign: 'left', padding: 8, borderBottom: '1px solid #ddd' };
const td: React.CSSProperties = { padding: 8, borderBottom: '1px solid #eee' };
