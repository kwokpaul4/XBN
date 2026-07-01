import React, { useEffect, useState } from 'react';
import { api } from '../api.ts';

/**
 * Phase 4.3 — Buyer status dashboard. Six tiles derived from documents
 * scoped to the active buyer org. See PHASES.md §4.3.
 */

interface DashboardResponse {
  tiles: {
    poAwaitingAcknowledgement: number;
    ocsToReview: number;
    asnsInTransit: number;
    invoicesPendingReview: number;
    releasesAwaitingCommit: number;
    activeSchedulingAgreements: number;
  };
}

export function BuyerDashboardPage(): React.ReactElement {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const d = await api<DashboardResponse>('/network/dashboards/buyer');
        setData(d);
      } catch (e) {
        setError(JSON.stringify(e));
      }
    })();
  }, []);

  if (error) return <p style={{ color: 'crimson' }}>Error: {error}</p>;
  if (!data) return <p>Loading…</p>;

  const tiles = [
    ['POs awaiting acknowledgement', data.tiles.poAwaitingAcknowledgement],
    ['Order confirmations to review', data.tiles.ocsToReview],
    ['ASNs in transit', data.tiles.asnsInTransit],
    ['Invoices pending review', data.tiles.invoicesPendingReview],
    ['Releases/forecasts awaiting commit', data.tiles.releasesAwaitingCommit],
    ['Active scheduling agreements', data.tiles.activeSchedulingAgreements],
  ] as const;

  return (
    <div>
      <h2>Buyer dashboard</h2>
      <div style={gridStyle}>
        {tiles.map(([label, value]) => (
          <div key={label} style={tileStyle}>
            <div style={{ fontSize: 40, fontWeight: 'bold' }}>{value}</div>
            <div style={{ color: '#555' }}>{label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

const gridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: 16,
};

const tileStyle: React.CSSProperties = {
  border: '1px solid #ddd',
  borderRadius: 6,
  padding: 20,
  background: '#fafafa',
};
