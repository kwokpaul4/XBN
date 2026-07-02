/**
 * Buyer-side "Create SA Release" form (PHASES.md §3.2).
 *
 * Single form handling both release types via a mode selector:
 *   - SA_RELEASE_FORECAST — planning-grade, no delivery-time
 *   - SA_RELEASE_JIT      — firm call-off, optional delivery-time
 *
 * Both auto-link CALLS_OFF → SA. Both can carry a supersedesReleaseDocumentId
 * to supersede a prior release of the same type.
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

interface ReleaseLine {
  requestedDeliveryDate: string;
  requestedDeliveryTime?: string;
  quantity: number;
  unitOfMeasure: string;
}

type ReleaseMode = 'SA_RELEASE_FORECAST' | 'SA_RELEASE_JIT';

const emptyLine = (): ReleaseLine => ({
  requestedDeliveryDate: '',
  quantity: 1,
  unitOfMeasure: 'EA',
});

export function CreateSaReleasePage(): React.ReactElement {
  const { me } = useMe();
  const navigate = useNavigate();
  const buyerOrgId = me?.activeMembership?.orgId;

  const [mode, setMode] = useState<ReleaseMode>('SA_RELEASE_JIT');
  const rels = useEligibleRelationships(buyerOrgId, 'BUYER', mode);
  const sas = usePredecessorCandidates('SCHEDULING_AGREEMENT', ['ACTIVE']);
  const priorReleases = usePredecessorCandidates(mode, ['ISSUED']);

  const [saId, setSaId] = useState('');
  const [saNumber, setSaNumber] = useState('');
  const [itemSku, setItemSku] = useState('');
  const [windowStart, setWindowStart] = useState('');
  const [windowEnd, setWindowEnd] = useState('');
  const [releaseLines, setReleaseLines] = useState<ReleaseLine[]>([emptyLine()]);
  const [supersedesId, setSupersedesId] = useState('');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!saId) return;
    void api<{
      documentNumber: string;
      currentVersion: { body: { itemSku?: string } } | null;
    }>(`/documents/${saId}`).then((d) => {
      setSaNumber(d.documentNumber);
      const b = d.currentVersion?.body ?? {};
      if (b.itemSku) setItemSku(b.itemSku);
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
        schedulingAgreementDocumentNumber: saNumber,
        schedulingAgreementDocumentId: saId,
        itemSku,
        windowStart,
        windowEnd,
        releaseLines: releaseLines.map((l) => ({
          requestedDeliveryDate: l.requestedDeliveryDate,
          quantity: l.quantity,
          unitOfMeasure: l.unitOfMeasure,
          ...(mode === 'SA_RELEASE_JIT' && l.requestedDeliveryTime
            ? { requestedDeliveryTime: l.requestedDeliveryTime }
            : {}),
        })),
      };
      if (supersedesId) body.supersedesReleaseDocumentId = supersedesId;
      if (notes) body.notes = notes;
      const result = await api<{ documentId: string }>('/documents', {
        method: 'POST',
        body: JSON.stringify({
          documentType: mode,
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
      <h2>Create SA Release</h2>
      <form onSubmit={submit} style={gridForm}>
        <fieldset style={fieldset}>
          <legend>Release mode</legend>
          <label style={label}>
            Release type
            <select
              value={mode}
              onChange={(e) => {
                setMode(e.target.value as ReleaseMode);
                setSupersedesId('');
              }}
            >
              <option value="SA_RELEASE_JIT">SA_RELEASE_JIT (firm — supplier ships)</option>
              <option value="SA_RELEASE_FORECAST">SA_RELEASE_FORECAST (planning-grade)</option>
            </select>
          </label>
        </fieldset>

        <fieldset style={fieldset}>
          <legend>Anchor SA</legend>
          <label style={label}>
            SA
            <select value={saId} onChange={(e) => setSaId(e.target.value)} required>
              <option value="">(pick one)</option>
              {sas.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.documentNumber}
                </option>
              ))}
            </select>
          </label>
          <label style={label}>
            Supersedes prior {mode} (optional)
            <select value={supersedesId} onChange={(e) => setSupersedesId(e.target.value)}>
              <option value="">(none)</option>
              {priorReleases.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.documentNumber}
                </option>
              ))}
            </select>
          </label>
        </fieldset>

        <fieldset style={fieldset}>
          <legend>Header</legend>
          <label style={label}>
            SKU
            <input value={itemSku} onChange={(e) => setItemSku(e.target.value)} required />
          </label>
          <label style={label}>
            Window start
            <input
              type="date"
              value={windowStart}
              onChange={(e) => setWindowStart(e.target.value)}
              required
            />
          </label>
          <label style={label}>
            Window end
            <input
              type="date"
              value={windowEnd}
              onChange={(e) => setWindowEnd(e.target.value)}
              required
            />
          </label>
        </fieldset>

        <fieldset style={fieldset}>
          <legend>Release lines</legend>
          {releaseLines.map((l, i) => (
            <div
              key={i}
              style={{
                display: 'grid',
                gridTemplateColumns:
                  mode === 'SA_RELEASE_JIT' ? 'repeat(4, 1fr) auto' : 'repeat(3, 1fr) auto',
                gap: 8,
              }}
            >
              <input
                type="date"
                value={l.requestedDeliveryDate}
                onChange={(e) => updateLine(i, { requestedDeliveryDate: e.target.value })}
                required
              />
              {mode === 'SA_RELEASE_JIT' && (
                <input
                  type="time"
                  value={l.requestedDeliveryTime ?? ''}
                  onChange={(e) => updateLine(i, { requestedDeliveryTime: e.target.value })}
                />
              )}
              <input
                type="number"
                placeholder="Qty"
                value={l.quantity}
                onChange={(e) => updateLine(i, { quantity: Number(e.target.value) })}
                step="any"
                min="0.0001"
                required
              />
              <input
                placeholder="UoM"
                value={l.unitOfMeasure}
                onChange={(e) => updateLine(i, { unitOfMeasure: e.target.value })}
                required
              />
              <button
                type="button"
                onClick={() => removeLine(i)}
                disabled={releaseLines.length === 1}
              >
                ×
              </button>
            </div>
          ))}
          <button type="button" onClick={() => setReleaseLines((ls) => [...ls, emptyLine()])}>
            + Add line
          </button>
        </fieldset>

        <label style={label}>
          Notes
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>

        <button type="submit" disabled={busy || !saId}>
          {busy ? 'Creating…' : `Create ${mode} (status: DRAFT)`}
        </button>
        {err && <pre style={errStyle}>{err}</pre>}
      </form>
    </section>
  );

  function updateLine(idx: number, patch: Partial<ReleaseLine>): void {
    setReleaseLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }
  function removeLine(idx: number): void {
    setReleaseLines((ls) => ls.filter((_, i) => i !== idx));
  }
}
