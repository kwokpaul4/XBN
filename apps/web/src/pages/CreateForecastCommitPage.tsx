/**
 * Supplier-side "Create Forecast Commit" form (PHASES.md §3.1).
 *
 * Response to a FORECAST_PUBLISH. Each bucket is one of COMMIT /
 * COMMIT_WITH_DEVIATION / CANNOT_COMMIT. The bucket forms swap fields
 * based on `mode`, matching the Zod discriminated union.
 */

import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type ApiError } from '../api.ts';
import { useMe } from '../auth-state.ts';
import {
  errStyle,
  fieldset,
  gridForm,
  label,
  useEligibleRelationships,
  usePredecessorCandidates,
} from './DocumentFormHelpers.tsx';

type BucketMode = 'COMMIT' | 'COMMIT_WITH_DEVIATION' | 'CANNOT_COMMIT';

interface Bucket {
  mode: BucketMode;
  periodStart: string;
  periodEnd: string;
  committedQuantity?: number;
  deviationReason?: string;
  reason?: string;
}

export function CreateForecastCommitPage(): React.ReactElement {
  const { me } = useMe();
  const navigate = useNavigate();
  const supplierOrgId = me?.activeMembership?.orgId;

  const rels = useEligibleRelationships(supplierOrgId, 'SUPPLIER', 'FORECAST_COMMIT');
  const forecasts = usePredecessorCandidates('FORECAST_PUBLISH', ['ISSUED']);

  const [forecastId, setForecastId] = useState('');
  const [forecastNumber, setForecastNumber] = useState('');
  const [itemSku, setItemSku] = useState('');
  const [unitOfMeasure, setUnitOfMeasure] = useState('EA');
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!forecastId) return;
    void api<{
      documentNumber: string;
      currentVersion: {
        body: {
          itemSku?: string;
          unitOfMeasure?: string;
          buckets?: Array<{ periodStart: string; periodEnd: string; forecastQuantity: number }>;
        };
      } | null;
    }>(`/documents/${forecastId}`).then((d) => {
      setForecastNumber(d.documentNumber);
      const body = d.currentVersion?.body ?? {};
      if (body.itemSku) setItemSku(body.itemSku);
      if (body.unitOfMeasure) setUnitOfMeasure(body.unitOfMeasure);
      setBuckets(
        (body.buckets ?? []).map((b) => ({
          mode: 'COMMIT' as BucketMode,
          periodStart: b.periodStart,
          periodEnd: b.periodEnd,
          committedQuantity: b.forecastQuantity,
        })),
      );
    });
  }, [forecastId]);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const rel = rels[0];
      const buyerOrgId = rel?.buyerOrgId;
      if (!buyerOrgId) throw new Error('no eligible buyer relationship');
      // Normalise each bucket to match the discriminated union.
      const normalisedBuckets = buckets.map((b) => {
        const base = { periodStart: b.periodStart, periodEnd: b.periodEnd };
        if (b.mode === 'COMMIT') {
          return { mode: 'COMMIT', ...base, committedQuantity: b.committedQuantity ?? 0 };
        }
        if (b.mode === 'COMMIT_WITH_DEVIATION') {
          return {
            mode: 'COMMIT_WITH_DEVIATION',
            ...base,
            committedQuantity: b.committedQuantity ?? 0,
            ...(b.deviationReason ? { deviationReason: b.deviationReason } : {}),
          };
        }
        return {
          mode: 'CANNOT_COMMIT',
          ...base,
          ...(b.reason ? { reason: b.reason } : {}),
        };
      });
      const result = await api<{ documentId: string }>('/documents', {
        method: 'POST',
        body: JSON.stringify({
          documentType: 'FORECAST_COMMIT',
          recipientOrgId: buyerOrgId,
          body: {
            forecastDocumentNumber: forecastNumber,
            forecastDocumentId: forecastId,
            itemSku,
            unitOfMeasure,
            buckets: normalisedBuckets,
          },
        }),
      });
      navigate(`/documents/${result.documentId}`);
    } catch (caught) {
      setErr(JSON.stringify((caught as ApiError).body ?? String(caught), null, 2));
      setBusy(false);
    }
  }

  if (!supplierOrgId) return <p>Set an active org first.</p>;

  return (
    <section>
      <h2>Commit to Forecast</h2>
      <form onSubmit={submit} style={gridForm}>
        <fieldset style={fieldset}>
          <legend>Forecast to respond to</legend>
          <label style={label}>
            Forecast
            <select value={forecastId} onChange={(e) => setForecastId(e.target.value)} required>
              <option value="">(pick one)</option>
              {forecasts.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.documentNumber}
                </option>
              ))}
            </select>
          </label>
        </fieldset>

        <fieldset style={fieldset}>
          <legend>Buckets — set a mode per bucket</legend>
          {buckets.length === 0 && <em>Pick a forecast above to load its buckets.</em>}
          {buckets.map((b, i) => (
            <div
              key={i}
              style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr) 2fr', gap: 8 }}
            >
              <input value={b.periodStart} readOnly style={{ background: '#f5f5f5' }} />
              <input value={b.periodEnd} readOnly style={{ background: '#f5f5f5' }} />
              <select
                value={b.mode}
                onChange={(e) => updateBucket(i, { mode: e.target.value as BucketMode })}
              >
                <option value="COMMIT">COMMIT</option>
                <option value="COMMIT_WITH_DEVIATION">COMMIT_WITH_DEVIATION</option>
                <option value="CANNOT_COMMIT">CANNOT_COMMIT</option>
              </select>
              {b.mode === 'CANNOT_COMMIT' ? (
                <>
                  <span />
                  <input
                    placeholder="Reason (optional)"
                    value={b.reason ?? ''}
                    onChange={(e) => updateBucket(i, { reason: e.target.value })}
                  />
                </>
              ) : (
                <>
                  <input
                    type="number"
                    placeholder="Committed qty"
                    value={b.committedQuantity ?? 0}
                    onChange={(e) => updateBucket(i, { committedQuantity: Number(e.target.value) })}
                    step="any"
                    min="0"
                    required={b.mode === 'COMMIT'}
                  />
                  {b.mode === 'COMMIT_WITH_DEVIATION' && (
                    <input
                      placeholder="Deviation reason (optional)"
                      value={b.deviationReason ?? ''}
                      onChange={(e) => updateBucket(i, { deviationReason: e.target.value })}
                    />
                  )}
                </>
              )}
            </div>
          ))}
        </fieldset>

        <button type="submit" disabled={busy || buckets.length === 0}>
          {busy ? 'Creating…' : 'Commit (status: DRAFT)'}
        </button>
        {err && <pre style={errStyle}>{err}</pre>}
      </form>
    </section>
  );

  function updateBucket(idx: number, patch: Partial<Bucket>): void {
    setBuckets((bs) => bs.map((b, i) => (i === idx ? { ...b, ...patch } : b)));
  }
}
