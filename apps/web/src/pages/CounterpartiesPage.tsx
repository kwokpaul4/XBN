import React, { useEffect, useState } from 'react';
import { api } from '../api.ts';

/**
 * Phase 4.2 — Supplier directory / trading-partner management.
 *
 * Read-only at MVP. Lists every counterparty (supplier from the buyer's
 * side, or buyer from the supplier's side) with the relationship's
 * enabled doc types and last-activity timestamp. The relationship-lifecycle
 * (suspend/terminate) HTTP routes are Phase 4.2 backend work marked as
 * pending in OPERATIONS.md §19 — this page renders what's exposed today.
 */

interface Counterparty {
  relationshipId: string;
  counterpartyOrgId: string;
  counterpartyLegalName: string;
  counterpartyDisplayName: string;
  ourRole: 'BUYER' | 'SUPPLIER';
  status: string;
  enabledDocumentTypes: string[];
  defaultCurrency: string | null;
  summaryInvoicingEnabled: boolean;
  establishedAt: string;
  lastActivityAt: string | null;
  lastDocument: { id: string; documentType: string; documentNumber: string } | null;
}

export function CounterpartiesPage(): React.ReactElement {
  const [rows, setRows] = useState<Counterparty[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const data = await api<{ counterparties: Counterparty[] }>('/network/counterparties');
        setRows(data.counterparties);
      } catch (e) {
        setError(JSON.stringify(e));
      }
    })();
  }, []);

  return (
    <div>
      <h2>Trading Partners</h2>
      {error && <p style={{ color: 'crimson' }}>Error: {error}</p>}
      {rows === null ? (
        <p>Loading…</p>
      ) : rows.length === 0 ? (
        <p>
          No counterparties yet. Establish a trading relationship from <a href="/admin">Admin</a>.
        </p>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th>Counterparty</th>
              <th>Our role</th>
              <th>Status</th>
              <th>Currency</th>
              <th>Enabled types</th>
              <th>Last activity</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.relationshipId}>
                <td>
                  <strong>{c.counterpartyDisplayName}</strong>
                  <br />
                  <span style={{ color: '#666', fontSize: 12 }}>{c.counterpartyLegalName}</span>
                </td>
                <td>{c.ourRole}</td>
                <td>{c.status}</td>
                <td>{c.defaultCurrency ?? '—'}</td>
                <td style={{ fontSize: 12 }}>
                  {c.enabledDocumentTypes.length} type
                  {c.enabledDocumentTypes.length === 1 ? '' : 's'}
                  <br />
                  <span style={{ color: '#666' }}>{c.enabledDocumentTypes.join(', ')}</span>
                </td>
                <td>
                  {c.lastActivityAt ? (
                    <>
                      {new Date(c.lastActivityAt).toLocaleString()}
                      {c.lastDocument && (
                        <>
                          <br />
                          <span style={{ color: '#666', fontSize: 12 }}>
                            {c.lastDocument.documentType} {c.lastDocument.documentNumber}
                          </span>
                        </>
                      )}
                    </>
                  ) : (
                    <span style={{ color: '#999' }}>—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse' };
