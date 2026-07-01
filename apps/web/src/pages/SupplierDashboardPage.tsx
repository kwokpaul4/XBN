import React, { useEffect, useState } from 'react';
import { api } from '../api.ts';

/**
 * Phase 4.3 — Supplier status dashboard. Six tiles derived from documents
 * scoped to the active supplier org. See PHASES.md §4.3.
 */

interface DashboardResponse {
  tiles: {
    posToAcknowledge: number;
    forecastsToCommit: number;
    jitReleasesToShip: number;
    invoicesSubmitted: number;
    invoicesAccepted: number;
    remittancesReceived: number;
  };
}

export function SupplierDashboardPage(): React.ReactElement {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const d = await api<DashboardResponse>('/network/dashboards/supplier');
        setData(d);
      } catch (e) {
        setError(JSON.stringify(e));
      }
    })();
  }, []);

  if (error) return <p style={{ color: 'crimson' }}>Error: {error}</p>;
  if (!data) return <p>Loading…</p>;

  const tiles = [
    ['POs to acknowledge', data.tiles.posToAcknowledge],
    ['Forecasts to commit', data.tiles.forecastsToCommit],
    ['JIT releases to ship', data.tiles.jitReleasesToShip],
    ['Invoices submitted', data.tiles.invoicesSubmitted],
    ['Invoices accepted', data.tiles.invoicesAccepted],
    ['Remittances received', data.tiles.remittancesReceived],
  ] as const;

  return (
    <div>
      <h2>Supplier dashboard</h2>
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
