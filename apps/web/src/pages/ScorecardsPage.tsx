import React, { useEffect, useState } from 'react';
import { api } from '../api.ts';

/**
 * Phase 4.4 — Supplier scorecards. Buyer-only view: for each active
 * supplier relationship, the four network-observable metrics from
 * PHASES.md §4.4.
 */

interface Scorecard {
  relationshipId: string;
  supplierOrgId: string;
  supplierLegalName: string;
  supplierDisplayName: string;
  metrics: {
    avgPoAckHours: number | null;
    poAckSampleSize: number;
    asnAccuracy: number | null;
    asnSampleSize: number;
    invoiceMatchRate: number | null;
    invoiceSampleSize: number;
    onTimeDelivery: number | null;
    onTimeSampleSize: number;
  };
}

interface Response {
  scorecards: Scorecard[];
  computedAt: string;
}

function pct(v: number | null): string {
  return v === null ? '—' : `${(v * 100).toFixed(1)}%`;
}

function hrs(v: number | null): string {
  return v === null ? '—' : `${v} h`;
}

export function ScorecardsPage(): React.ReactElement {
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const d = await api<Response>('/network/scorecards');
        setData(d);
      } catch (e) {
        setError(JSON.stringify(e));
      }
    })();
  }, []);

  if (error) return <p style={{ color: 'crimson' }}>Error: {error}</p>;
  if (!data) return <p>Loading…</p>;

  return (
    <div>
      <h2>Supplier scorecards</h2>
      <p style={{ color: '#666', fontSize: 12 }}>
        Computed live from the document corpus at {new Date(data.computedAt).toLocaleString()}. Only
        network-observable metrics — no buyer-internal approval data. Nulls mean "no data yet"
        rather than zero.
      </p>
      {data.scorecards.length === 0 ? (
        <p>No active supplier relationships.</p>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th>Supplier</th>
              <th>Avg PO ack</th>
              <th>ASN accuracy</th>
              <th>Invoice match</th>
              <th>On-time</th>
            </tr>
          </thead>
          <tbody>
            {data.scorecards.map((s) => (
              <tr key={s.relationshipId}>
                <td>
                  <strong>{s.supplierDisplayName}</strong>
                  <br />
                  <span style={{ color: '#666', fontSize: 12 }}>{s.supplierLegalName}</span>
                </td>
                <td>
                  {hrs(s.metrics.avgPoAckHours)}
                  <br />
                  <span style={{ color: '#666', fontSize: 12 }}>n={s.metrics.poAckSampleSize}</span>
                </td>
                <td>
                  {pct(s.metrics.asnAccuracy)}
                  <br />
                  <span style={{ color: '#666', fontSize: 12 }}>n={s.metrics.asnSampleSize}</span>
                </td>
                <td>
                  {pct(s.metrics.invoiceMatchRate)}
                  <br />
                  <span style={{ color: '#666', fontSize: 12 }}>
                    n={s.metrics.invoiceSampleSize}
                  </span>
                </td>
                <td>
                  {pct(s.metrics.onTimeDelivery)}
                  <br />
                  <span style={{ color: '#666', fontSize: 12 }}>
                    n={s.metrics.onTimeSampleSize}
                  </span>
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
