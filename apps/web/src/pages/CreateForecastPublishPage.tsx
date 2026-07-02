/**
 * Buyer-side "Create Forecast Publish" form (PHASES.md §3.1).
 *
 * Bucketed demand signal against a SCHEDULING_AGREEMENT. Buckets are
 * time windows with a forecast quantity. Revisions supersede prior
 * forecasts for the same (sku, window).
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

interface Bucket {
  periodStart: string;
  periodEnd: string;
  forecastQuantity: number;
}

export function CreateForecastPublishPage(): React.ReactElement {
  const { me } = useMe();
  const navigate = useNavigate();
  const buyerOrgId = me?.activeMembership?.orgId;

  const rels = useEligibleRelationships(buyerOrgId, 'BUYER', 'FORECAST_PUBLISH');
  const sas = usePredecessorCandidates('SCHEDULING_AGREEMENT', ['ACTIVE']);
  const priorForecasts = usePredecessorCandidates('FORECAST_PUBLISH', ['ISSUED']);

  const [saId, setSaId] = useState('');
  const [saNumber, setSaNumber] = useState('');
  const [itemSku, setItemSku] = useState('');
  const [itemDescription, setItemDescription] = useState('');
  const [unitOfMeasure, setUnitOfMeasure] = useState('EA');
  const [horizonStart, setHorizonStart] = useState('');
  const [horizonEnd, setHorizonEnd] = useState('');
  const [buckets, setBuckets] = useState<Bucket[]>([
    { periodStart: '', periodEnd: '', forecastQuantity: 0 },
  ]);
  const [supersedesId, setSupersedesId] = useState('');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!saId) return;
    void api<{
      documentNumber: string;
      currentVersion: {
        body: { itemSku?: string; itemDescription?: string; unitOfMeasure?: string };
      } | null;
    }>(`/documents/${saId}`).then((d) => {
      setSaNumber(d.documentNumber);
      const b = d.currentVersion?.body ?? {};
      if (b.itemSku) setItemSku(b.itemSku);
      if (b.itemDescription) setItemDescription(b.itemDescription);
      if (b.unitOfMeasure) setUnitOfMeasure(b.unitOfMeasure);
    });
  }, [saId]);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const rel = rels[0];
      const supplierOrgId = rel?.supplierOrgId;
      if (!supplierOrgId) throw new Error('no eligible supplier relationship');
      const body: Record<string, unknown> = {
        itemSku,
        itemDescription,
        unitOfMeasure,
        horizonStart,
        horizonEnd,
        buckets,
      };
      if (saId) {
        body.schedulingAgreementDocumentId = saId;
        body.schedulingAgreementDocumentNumber = saNumber;
      }
      if (supersedesId) body.supersedesForecastDocumentId = supersedesId;
      if (notes) body.notes = notes;
      const result = await api<{ documentId: string }>('/documents', {
        method: 'POST',
        body: JSON.stringify({
          documentType: 'FORECAST_PUBLISH',
          recipientOrgId: supplierOrgId,
          body,
        }),
      });
      navigate(`/documents/${result.documentId}`);
    } catch (caught) {
      setErr(JSON.stringify((caught as ApiError).body ?? String(caught), null, 2));
      setBusy(false);
    }
  }

  if (!buyerOrgId) return <p>Set an active org first.</p>;

  return (
    <section>
      <h2>Publish Forecast</h2>
      <form onSubmit={submit} style={gridForm}>
        <fieldset style={fieldset}>
          <legend>Anchor Scheduling Agreement (optional)</legend>
          <label style={label}>
            SA
            <select value={saId} onChange={(e) => setSaId(e.target.value)}>
              <option value="">(no SA — sku-supplier-pair forecast)</option>
              {sas.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.documentNumber}
                </option>
              ))}
            </select>
          </label>
          <label style={label}>
            Supersedes prior forecast (optional)
            <select value={supersedesId} onChange={(e) => setSupersedesId(e.target.value)}>
              <option value="">(none)</option>
              {priorForecasts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.documentNumber}
                </option>
              ))}
            </select>
          </label>
        </fieldset>

        <fieldset style={fieldset}>
          <legend>Item + horizon</legend>
          <label style={label}>
            SKU
            <input value={itemSku} onChange={(e) => setItemSku(e.target.value)} required />
          </label>
          <label style={label}>
            Description
            <input
              value={itemDescription}
              onChange={(e) => setItemDescription(e.target.value)}
              required
            />
          </label>
          <label style={label}>
            UoM
            <input
              value={unitOfMeasure}
              onChange={(e) => setUnitOfMeasure(e.target.value)}
              required
            />
          </label>
          <label style={label}>
            Horizon start
            <input
              type="date"
              value={horizonStart}
              onChange={(e) => setHorizonStart(e.target.value)}
              required
            />
          </label>
          <label style={label}>
            Horizon end
            <input
              type="date"
              value={horizonEnd}
              onChange={(e) => setHorizonEnd(e.target.value)}
              required
            />
          </label>
        </fieldset>

        <fieldset style={fieldset}>
          <legend>Buckets</legend>
          {buckets.map((b, i) => (
            <div
              key={i}
              style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr) auto', gap: 8 }}
            >
              <input
                type="date"
                value={b.periodStart}
                onChange={(e) => updateBucket(i, { periodStart: e.target.value })}
                required
              />
              <input
                type="date"
                value={b.periodEnd}
                onChange={(e) => updateBucket(i, { periodEnd: e.target.value })}
                required
              />
              <input
                type="number"
                placeholder="Forecast qty"
                value={b.forecastQuantity}
                onChange={(e) => updateBucket(i, { forecastQuantity: Number(e.target.value) })}
                step="any"
                min="0"
                required
              />
              <button type="button" onClick={() => removeBucket(i)} disabled={buckets.length === 1}>
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              setBuckets((bs) => [...bs, { periodStart: '', periodEnd: '', forecastQuantity: 0 }])
            }
          >
            + Add bucket
          </button>
        </fieldset>

        <label style={label}>
          Notes
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>

        <button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Publish Forecast (status: DRAFT)'}
        </button>
        {err && <pre style={errStyle}>{err}</pre>}
      </form>
    </section>
  );

  function updateBucket(idx: number, patch: Partial<Bucket>): void {
    setBuckets((bs) => bs.map((b, i) => (i === idx ? { ...b, ...patch } : b)));
  }
  function removeBucket(idx: number): void {
    setBuckets((bs) => bs.filter((_, i) => i !== idx));
  }
}
