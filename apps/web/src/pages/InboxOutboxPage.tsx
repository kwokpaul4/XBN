import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.ts';

/**
 * Phase 4.1 — Inbox / Outbox / cross-type document search.
 *
 * Single page, filterable, works for both buyer and supplier roles. The
 * route accepts `box`, `q`, `documentType`, `status`, `counterpartyOrgId`,
 * `fromDate`, `toDate` — all pass-through to GET /documents. Result table
 * links back to the doc-type-specific detail routes where they exist
 * (PO / PO_CHANGE / OC) and to a generic /documents/:id JSON dump
 * otherwise.
 */

interface DocRow {
  id: string;
  documentType: string;
  documentNumber: string;
  issuerOrgId: string;
  recipientOrgId: string;
  status: string;
  createdAt: string;
  currency: string | null;
  totalAmount: string | null;
  issueDate: string | null;
}

interface Counterparty {
  counterpartyOrgId: string;
  counterpartyDisplayName: string;
}

const TYPED_DETAIL_ROUTES: Record<string, (role: 'buyer' | 'supplier', id: string) => string> = {
  PO: (role, id) => `/${role}/po/${id}`,
  PO_CHANGE: (role, id) => `/${role}/po-change/${id}`,
  ORDER_CONFIRMATION: (role, id) => `/${role}/order-confirmation/${id}`,
};

export function InboxOutboxPage(): React.ReactElement {
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<DocRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [cps, setCps] = useState<Counterparty[]>([]);

  const box = (params.get('box') ?? 'both') as 'inbox' | 'outbox' | 'both';
  const q = params.get('q') ?? '';
  const documentType = params.get('documentType') ?? '';
  const status = params.get('status') ?? '';
  const counterpartyOrgId = params.get('counterpartyOrgId') ?? '';
  const fromDate = params.get('fromDate') ?? '';
  const toDate = params.get('toDate') ?? '';

  useEffect(() => {
    void (async () => {
      try {
        const qs = new URLSearchParams();
        qs.set('box', box);
        if (q) qs.set('q', q);
        if (documentType) qs.set('documentType', documentType);
        if (status) qs.set('status', status);
        if (counterpartyOrgId) qs.set('counterpartyOrgId', counterpartyOrgId);
        if (fromDate) qs.set('fromDate', fromDate);
        if (toDate) qs.set('toDate', toDate);
        const data = await api<{ documents: DocRow[]; total: number }>(`/documents?${qs}`);
        setRows(data.documents);
        setTotal(data.total);
      } catch (e) {
        setError(JSON.stringify(e));
      }
    })();
  }, [box, q, documentType, status, counterpartyOrgId, fromDate, toDate]);

  useEffect(() => {
    void (async () => {
      try {
        const data = await api<{ counterparties: Counterparty[] }>('/network/counterparties');
        setCps(data.counterparties);
      } catch {
        // Not critical for the page — the filter dropdown just stays empty.
      }
    })();
  }, []);

  function set(k: string, v: string): void {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next);
  }

  return (
    <div>
      <h2>Inbox / Outbox</h2>
      <div style={filterRowStyle}>
        <label>
          Box{' '}
          <select value={box} onChange={(e) => set('box', e.target.value)}>
            <option value="both">Both</option>
            <option value="inbox">Inbox</option>
            <option value="outbox">Outbox</option>
          </select>
        </label>
        <label>
          Search{' '}
          <input
            value={q}
            placeholder="doc# or reference"
            onChange={(e) => set('q', e.target.value)}
          />
        </label>
        <label>
          Type{' '}
          <input
            value={documentType}
            placeholder="e.g. PO"
            onChange={(e) => set('documentType', e.target.value)}
          />
        </label>
        <label>
          Status <input value={status} onChange={(e) => set('status', e.target.value)} />
        </label>
        <label>
          Counterparty{' '}
          <select
            value={counterpartyOrgId}
            onChange={(e) => set('counterpartyOrgId', e.target.value)}
          >
            <option value="">All</option>
            {cps.map((c) => (
              <option key={c.counterpartyOrgId} value={c.counterpartyOrgId}>
                {c.counterpartyDisplayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          From{' '}
          <input type="date" value={fromDate} onChange={(e) => set('fromDate', e.target.value)} />
        </label>
        <label>
          To <input type="date" value={toDate} onChange={(e) => set('toDate', e.target.value)} />
        </label>
      </div>

      {error && <p style={{ color: 'crimson' }}>Error: {error}</p>}
      {rows === null ? (
        <p>Loading…</p>
      ) : rows.length === 0 ? (
        <p>No documents match this filter.</p>
      ) : (
        <>
          <p>
            {total} document{total === 1 ? '' : 's'}
          </p>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th>Number</th>
                <th>Type</th>
                <th>Status</th>
                <th>Amount</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td>{d.documentNumber}</td>
                  <td>{d.documentType}</td>
                  <td>{d.status}</td>
                  <td>{d.totalAmount ? `${d.totalAmount} ${d.currency ?? ''}` : '—'}</td>
                  <td>{new Date(d.createdAt).toLocaleString()}</td>
                  <td>
                    {(() => {
                      const route =
                        TYPED_DETAIL_ROUTES[d.documentType]?.('buyer', d.id) ??
                        `/documents/${d.id}`;
                      return <Link to={route}>open</Link>;
                    })()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

const filterRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 12,
  flexWrap: 'wrap',
  marginBottom: 16,
  padding: 12,
  background: '#f5f5f5',
  borderRadius: 4,
};

const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse' };
