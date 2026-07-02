/**
 * Buyer-side "Create Goods Receipt" form (PHASES.md §2.5).
 *
 * Records what physically arrived against an ASN. The API auto-links
 * RECEIVES → ASN and FULFILLS → PO. Line refs and quantities pre-fill
 * from the selected ASN so the receiver only edits the actual received
 * quantity + optional rejection info.
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

interface Line {
  lineRef: string;
  sku: string;
  receivedQuantity: number;
  unitOfMeasure: string;
  rejectedQuantity?: number;
  rejectionReason?: string;
  notes?: string;
}

interface AsnBodyPreview {
  poDocumentId?: string;
  poDocumentNumber?: string;
  lines?: Array<{
    lineRef?: string;
    sku?: string;
    shippedQuantity?: number;
    unitOfMeasure?: string;
  }>;
}

export function CreateGoodsReceiptPage(): React.ReactElement {
  const { me } = useMe();
  const navigate = useNavigate();
  const buyerOrgId = me?.activeMembership?.orgId;

  const rels = useEligibleRelationships(buyerOrgId, 'BUYER', 'GOODS_RECEIPT');
  const asns = usePredecessorCandidates('ASN', ['ISSUED', 'IN_TRANSIT', 'DELIVERED']);

  const [asnId, setAsnId] = useState('');
  const [asnNumber, setAsnNumber] = useState('');
  const [poId, setPoId] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [receivedAt, setReceivedAt] = useState(new Date().toISOString().slice(0, 10));
  const [receivedBy, setReceivedBy] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!asnId) {
      setLines([]);
      return;
    }
    void api<{
      documentNumber: string;
      currentVersion: { body: AsnBodyPreview } | null;
    }>(`/documents/${asnId}`).then((d) => {
      setAsnNumber(d.documentNumber);
      const body = d.currentVersion?.body ?? {};
      setPoId(body.poDocumentId ?? '');
      setPoNumber(body.poDocumentNumber ?? '');
      setLines(
        (body.lines ?? []).map((l) => ({
          lineRef: l.lineRef ?? l.sku ?? '',
          sku: l.sku ?? '',
          receivedQuantity: l.shippedQuantity ?? 0,
          unitOfMeasure: l.unitOfMeasure ?? 'EA',
        })),
      );
    });
  }, [asnId]);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const rel = rels[0];
      const supplierOrgId = rel?.supplierOrgId;
      if (!supplierOrgId) throw new Error('no eligible supplier relationship');
      if (!poId) throw new Error('predecessor ASN has no poDocumentId — cannot auto-link FULFILLS');
      const body = {
        poDocumentNumber: poNumber,
        poDocumentId: poId,
        asnDocumentNumber: asnNumber,
        asnDocumentId: asnId,
        receivedAt,
        receivedBy: receivedBy || undefined,
        lines: lines.map((l) => ({
          lineRef: l.lineRef,
          sku: l.sku,
          receivedQuantity: l.receivedQuantity,
          unitOfMeasure: l.unitOfMeasure,
          ...(l.rejectedQuantity !== undefined && l.rejectedQuantity > 0
            ? { rejectedQuantity: l.rejectedQuantity }
            : {}),
          ...(l.rejectionReason ? { rejectionReason: l.rejectionReason } : {}),
          ...(l.notes ? { notes: l.notes } : {}),
        })),
      };
      const result = await api<{ documentId: string }>('/documents', {
        method: 'POST',
        body: JSON.stringify({
          documentType: 'GOODS_RECEIPT',
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
      <h2>Create Goods Receipt</h2>
      {rels.length === 0 && (
        <p style={{ color: '#a00' }}>
          No ACTIVE relationships with GOODS_RECEIPT enabled from this buyer org.
        </p>
      )}
      <form onSubmit={submit} style={gridForm}>
        <fieldset style={fieldset}>
          <legend>Predecessor ASN</legend>
          <label style={label}>
            ASN
            <select value={asnId} onChange={(e) => setAsnId(e.target.value)} required>
              <option value="">(pick one)</option>
              {asns.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.documentNumber} · {a.status}
                </option>
              ))}
            </select>
          </label>
          {poNumber && (
            <p style={{ color: '#666', fontSize: 12 }}>
              PO auto-detected: <code>{poNumber}</code> · FULFILLS link will be auto-created
            </p>
          )}
        </fieldset>

        <fieldset style={fieldset}>
          <legend>Receipt header</legend>
          <label style={label}>
            Received at
            <input
              type="date"
              value={receivedAt}
              onChange={(e) => setReceivedAt(e.target.value)}
              required
            />
          </label>
          <label style={label}>
            Received by (optional)
            <input
              placeholder="e.g. Alice at Dock B"
              value={receivedBy}
              onChange={(e) => setReceivedBy(e.target.value)}
            />
          </label>
        </fieldset>

        <fieldset style={fieldset}>
          <legend>Lines (edit received quantities)</legend>
          {lines.length === 0 && <em>Pick an ASN above to load lines.</em>}
          {lines.map((l, i) => (
            <div
              key={i}
              style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr) 2fr', gap: 8 }}
            >
              <input value={l.lineRef} readOnly style={{ background: '#f5f5f5' }} />
              <input value={l.sku} readOnly style={{ background: '#f5f5f5' }} />
              <input
                type="number"
                placeholder="Received"
                value={l.receivedQuantity}
                onChange={(e) => updateLine(i, { receivedQuantity: Number(e.target.value) })}
                step="any"
                min="0"
                required
              />
              <input
                type="number"
                placeholder="Rejected"
                value={l.rejectedQuantity ?? 0}
                onChange={(e) => updateLine(i, { rejectedQuantity: Number(e.target.value) })}
                step="any"
                min="0"
              />
              <input value={l.unitOfMeasure} readOnly style={{ background: '#f5f5f5' }} />
              <input
                placeholder="Rejection reason / notes"
                value={l.notes ?? l.rejectionReason ?? ''}
                onChange={(e) => updateLine(i, { notes: e.target.value })}
              />
            </div>
          ))}
        </fieldset>

        <button type="submit" disabled={busy || lines.length === 0}>
          {busy ? 'Creating…' : 'Post Goods Receipt'}
        </button>
        {err && <pre style={errStyle}>{err}</pre>}
      </form>
    </section>
  );

  function updateLine(idx: number, patch: Partial<Line>): void {
    setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }
}
