/**
 * Supplier-side "Create ASN" form (PHASES.md §2.4).
 *
 * Ships a shipment against a PO (Phase 2) or a SA_RELEASE_JIT (Phase 3.2
 * polymorphic predecessor). Picker at the top toggles between the two;
 * the auto-linker on the API side reads whichever id we send.
 *
 * Line refs must match the predecessor's line refs — we pre-fill the
 * `lineRef` and `sku` columns from the selected predecessor's body.
 */

import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type ApiError } from '../api.ts';
import { useMe } from '../auth-state.ts';
import {
  AddressBlock,
  emptyAddress,
  errStyle,
  fieldset,
  gridForm,
  label,
  useEligibleRelationships,
  usePredecessorCandidates,
} from './DocumentFormHelpers.tsx';

interface Line {
  lineRef: string;
  sku: string;
  shippedQuantity: number;
  unitOfMeasure: string;
  lotNumber?: string;
}

interface PredecessorBodyLine {
  lineRef?: string;
  sku?: string;
  quantity?: number;
  unitOfMeasure?: string;
}

const emptyLine = (): Line => ({
  lineRef: '',
  sku: '',
  shippedQuantity: 1,
  unitOfMeasure: 'EA',
});

export function CreateAsnPage(): React.ReactElement {
  const { me } = useMe();
  const navigate = useNavigate();
  const supplierOrgId = me?.activeMembership?.orgId;

  const [predecessorType, setPredecessorType] = useState<'PO' | 'SA_RELEASE_JIT'>('PO');
  const rels = useEligibleRelationships(supplierOrgId, 'SUPPLIER', 'ASN');
  const candidates = usePredecessorCandidates(
    predecessorType,
    predecessorType === 'PO' ? ['ISSUED', 'ACKNOWLEDGED', 'IN_FULFILLMENT'] : ['ISSUED'],
  );

  const [predecessorId, setPredecessorId] = useState('');
  const [predecessorNumber, setPredecessorNumber] = useState('');
  const [carrier, setCarrier] = useState('UPS');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [shippedAt, setShippedAt] = useState(new Date().toISOString().slice(0, 10));
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState('');
  const [shipFrom, setShipFrom] = useState(emptyAddress());
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // When the predecessor changes, pre-fill lines from its body so the
  // supplier only has to type quantities and lots.
  useEffect(() => {
    if (!predecessorId) return;
    void api<{
      documentNumber: string;
      recipientOrgId: string;
      currentVersion: { body: { lines?: PredecessorBodyLine[] } } | null;
    }>(`/documents/${predecessorId}`).then((d) => {
      setPredecessorNumber(d.documentNumber);
      const bodyLines = d.currentVersion?.body?.lines ?? [];
      setLines(
        bodyLines.map((l) => ({
          lineRef: l.lineRef ?? l.sku ?? '',
          sku: l.sku ?? '',
          shippedQuantity: l.quantity ?? 1,
          unitOfMeasure: l.unitOfMeasure ?? 'EA',
        })),
      );
    });
  }, [predecessorId]);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        carrier,
        shippedAt,
        expectedDeliveryDate,
        shipFrom,
        lines,
      };
      if (trackingNumber) body.trackingNumber = trackingNumber;
      if (predecessorType === 'PO') {
        body.poDocumentId = predecessorId;
        body.poDocumentNumber = predecessorNumber;
      } else {
        body.saReleaseJitDocumentId = predecessorId;
        body.saReleaseJitDocumentNumber = predecessorNumber;
      }
      // The ASN's recipient is the buyer side of the trading relationship.
      const rel = rels[0]; // supplier only has one buyer per predecessor in practice
      const recipientOrgId = rel?.buyerOrgId;
      if (!recipientOrgId) throw new Error('no eligible buyer relationship');
      const result = await api<{ documentId: string }>('/documents', {
        method: 'POST',
        body: JSON.stringify({
          documentType: 'ASN',
          recipientOrgId,
          body,
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
      <h2>Create ASN (Advance Ship Notice)</h2>
      {rels.length === 0 && (
        <p style={{ color: '#a00' }}>
          No ACTIVE relationships with ASN enabled from this supplier org.
        </p>
      )}
      <form onSubmit={submit} style={gridForm}>
        <fieldset style={fieldset}>
          <legend>Predecessor</legend>
          <label style={label}>
            Shipping against
            <select
              value={predecessorType}
              onChange={(e) => {
                setPredecessorType(e.target.value as 'PO' | 'SA_RELEASE_JIT');
                setPredecessorId('');
                setLines([emptyLine()]);
              }}
            >
              <option value="PO">Purchase Order (PO)</option>
              <option value="SA_RELEASE_JIT">JIT Release (SA_RELEASE_JIT)</option>
            </select>
          </label>
          <label style={label}>
            {predecessorType}
            <select
              value={predecessorId}
              onChange={(e) => setPredecessorId(e.target.value)}
              required
            >
              <option value="">(pick one)</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.documentNumber} · {c.status}
                </option>
              ))}
            </select>
          </label>
        </fieldset>

        <fieldset style={fieldset}>
          <legend>Shipment header</legend>
          <label style={label}>
            Carrier
            <input value={carrier} onChange={(e) => setCarrier(e.target.value)} required />
          </label>
          <label style={label}>
            Tracking number (optional)
            <input value={trackingNumber} onChange={(e) => setTrackingNumber(e.target.value)} />
          </label>
          <label style={label}>
            Shipped at
            <input
              type="date"
              value={shippedAt}
              onChange={(e) => setShippedAt(e.target.value)}
              required
            />
          </label>
          <label style={label}>
            Expected delivery
            <input
              type="date"
              value={expectedDeliveryDate}
              onChange={(e) => setExpectedDeliveryDate(e.target.value)}
              required
            />
          </label>
        </fieldset>

        <AddressBlock legend="Ship from" address={shipFrom} onChange={setShipFrom} />

        <fieldset style={fieldset}>
          <legend>Lines (pre-filled from predecessor)</legend>
          {lines.map((l, i) => (
            <div
              key={i}
              style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr) auto', gap: 8 }}
            >
              <input
                placeholder="lineRef"
                value={l.lineRef}
                onChange={(e) => updateLine(i, { lineRef: e.target.value })}
                required
              />
              <input
                placeholder="SKU"
                value={l.sku}
                onChange={(e) => updateLine(i, { sku: e.target.value })}
                required
              />
              <input
                type="number"
                placeholder="Shipped qty"
                value={l.shippedQuantity}
                onChange={(e) => updateLine(i, { shippedQuantity: Number(e.target.value) })}
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
              <input
                placeholder="Lot #"
                value={l.lotNumber ?? ''}
                onChange={(e) => updateLine(i, { lotNumber: e.target.value })}
              />
              <button type="button" onClick={() => removeLine(i)} disabled={lines.length === 1}>
                ×
              </button>
            </div>
          ))}
          <button type="button" onClick={() => setLines((ls) => [...ls, emptyLine()])}>
            + Add line
          </button>
        </fieldset>

        <button type="submit" disabled={busy || !predecessorId}>
          {busy ? 'Creating…' : 'Create ASN (status: DRAFT)'}
        </button>
        {err && <pre style={errStyle}>{err}</pre>}
      </form>
    </section>
  );

  function updateLine(idx: number, patch: Partial<Line>): void {
    setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }
  function removeLine(idx: number): void {
    setLines((ls) => ls.filter((_, i) => i !== idx));
  }
}
