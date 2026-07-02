/**
 * Supplier-side "Create Invoice" form (PHASES.md §2.6).
 *
 * Two modes on the same page toggled at the top:
 *   - PO_FLIP  — one PO. Lines pre-fill from the PO body.
 *   - SUMMARY  — many source documents (POs / GRs). One row per source.
 *                Only enabled when the trading relationship has
 *                `summaryInvoicingEnabled = true`.
 *
 * Totals stay flat: we compute subtotal / taxTotal / total from the
 * lines client-side; the API stores what we send (no server-side
 * recalc, per PHASES.md §2.6 "match status is a visibility aid, not
 * an approval gate").
 */

import React, { useEffect, useMemo, useState } from 'react';
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
  description: string;
  quantity: number;
  unitPrice: number;
  unitOfMeasure: string;
  sourceDocumentType?: string;
  sourceDocumentId?: string;
}

interface SummarySource {
  documentType: string;
  documentId: string;
  documentNumber: string;
}

const emptyLine = (): Line => ({
  lineRef: '',
  sku: '',
  description: '',
  quantity: 1,
  unitPrice: 0,
  unitOfMeasure: 'EA',
});

export function CreateInvoicePage(): React.ReactElement {
  const { me } = useMe();
  const navigate = useNavigate();
  const supplierOrgId = me?.activeMembership?.orgId;

  const [invoiceMode, setInvoiceMode] = useState<'PO_FLIP' | 'SUMMARY'>('PO_FLIP');
  const rels = useEligibleRelationships(supplierOrgId, 'SUPPLIER', 'INVOICE');
  const summaryAllowed = useMemo(
    () =>
      rels.some(
        (r) => (r as unknown as { summaryInvoicingEnabled?: boolean }).summaryInvoicingEnabled,
      ),
    [rels],
  );
  const pos = usePredecessorCandidates('PO', ['ACKNOWLEDGED', 'IN_FULFILLMENT']);
  const grs = usePredecessorCandidates('GOODS_RECEIPT');

  // PO_FLIP mode state
  const [poId, setPoId] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [grIds, setGrIds] = useState<string[]>([]);

  // SUMMARY mode state
  const [sources, setSources] = useState<SummarySource[]>([]);
  const [billingPeriodStart, setBillingPeriodStart] = useState('');
  const [billingPeriodEnd, setBillingPeriodEnd] = useState('');

  // Shared header
  const [issueDate, setIssueDate] = useState(new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [remitTo, setRemitTo] = useState(emptyAddress());
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const subtotal = lines.reduce((acc, l) => acc + l.quantity * l.unitPrice, 0);
  const taxTotal = 0;
  const total = subtotal + taxTotal;

  useEffect(() => {
    if (invoiceMode !== 'PO_FLIP' || !poId) return;
    void api<{
      documentNumber: string;
      currentVersion: {
        body: {
          currency?: string;
          lines?: Array<{
            sku?: string;
            description?: string;
            quantity?: number;
            unitPrice?: number;
            unitOfMeasure?: string;
          }>;
        };
      } | null;
    }>(`/documents/${poId}`).then((d) => {
      setPoNumber(d.documentNumber);
      const body = d.currentVersion?.body ?? {};
      if (body.currency) setCurrency(body.currency);
      setLines(
        (body.lines ?? []).map((l) => ({
          lineRef: l.sku ?? '',
          sku: l.sku ?? '',
          description: l.description ?? '',
          quantity: l.quantity ?? 1,
          unitPrice: l.unitPrice ?? 0,
          unitOfMeasure: l.unitOfMeasure ?? 'EA',
        })),
      );
    });
  }, [invoiceMode, poId]);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const rel = rels[0];
      const buyerOrgId = rel?.buyerOrgId;
      if (!buyerOrgId) throw new Error('no eligible buyer relationship');
      const base = {
        issueDate,
        dueDate,
        currency,
        remitTo,
        lines,
        subtotal,
        taxTotal,
        total,
        ...(notes ? { notes } : {}),
      };
      const body =
        invoiceMode === 'PO_FLIP'
          ? {
              invoiceMode: 'PO_FLIP',
              poDocumentNumber: poNumber,
              poDocumentId: poId,
              ...(grIds.length ? { grDocumentIds: grIds } : {}),
              ...base,
            }
          : {
              invoiceMode: 'SUMMARY',
              sourceDocuments: sources,
              billingPeriodStart,
              billingPeriodEnd,
              ...base,
            };
      const result = await api<{ documentId: string }>('/documents', {
        method: 'POST',
        body: JSON.stringify({
          documentType: 'INVOICE',
          recipientOrgId: buyerOrgId,
          invoiceMode,
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
      <h2>Create Invoice</h2>
      <form onSubmit={submit} style={gridForm}>
        <fieldset style={fieldset}>
          <legend>Mode</legend>
          <label style={label}>
            Invoice mode
            <select
              value={invoiceMode}
              onChange={(e) => setInvoiceMode(e.target.value as 'PO_FLIP' | 'SUMMARY')}
            >
              <option value="PO_FLIP">PO Flip (single PO)</option>
              <option value="SUMMARY" disabled={!summaryAllowed}>
                Summary (consolidated) {summaryAllowed ? '' : '— not enabled on relationship'}
              </option>
            </select>
          </label>
        </fieldset>

        {invoiceMode === 'PO_FLIP' ? (
          <fieldset style={fieldset}>
            <legend>PO reference</legend>
            <label style={label}>
              PO
              <select value={poId} onChange={(e) => setPoId(e.target.value)} required>
                <option value="">(pick one)</option>
                {pos.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.documentNumber} · {p.status}
                  </option>
                ))}
              </select>
            </label>
            <label style={label}>
              Goods receipts (multi-select, for 3-way match visibility)
              <select
                multiple
                value={grIds}
                onChange={(e) => setGrIds(Array.from(e.target.selectedOptions).map((o) => o.value))}
                size={Math.min(4, Math.max(2, grs.length))}
              >
                {grs.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.documentNumber}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>
        ) : (
          <fieldset style={fieldset}>
            <legend>Summary sources + billing period</legend>
            <label style={label}>
              Billing period start
              <input
                type="date"
                value={billingPeriodStart}
                onChange={(e) => setBillingPeriodStart(e.target.value)}
                required
              />
            </label>
            <label style={label}>
              Billing period end
              <input
                type="date"
                value={billingPeriodEnd}
                onChange={(e) => setBillingPeriodEnd(e.target.value)}
                required
              />
            </label>
            <label style={label}>
              Source POs (multi-select)
              <select
                multiple
                value={sources.filter((s) => s.documentType === 'PO').map((s) => s.documentId)}
                onChange={(e) => {
                  const selected = Array.from(e.target.selectedOptions).map((o) => o.value);
                  const others = sources.filter((s) => s.documentType !== 'PO');
                  const poSources: SummarySource[] = selected.map((id) => {
                    const p = pos.find((x) => x.id === id);
                    return {
                      documentType: 'PO',
                      documentId: id,
                      documentNumber: p?.documentNumber ?? '',
                    };
                  });
                  setSources([...others, ...poSources]);
                }}
                size={Math.min(6, Math.max(3, pos.length))}
              >
                {pos.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.documentNumber}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>
        )}

        <fieldset style={fieldset}>
          <legend>Header</legend>
          <label style={label}>
            Issue date
            <input
              type="date"
              value={issueDate}
              onChange={(e) => setIssueDate(e.target.value)}
              required
            />
          </label>
          <label style={label}>
            Due date
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              required
            />
          </label>
          <label style={label}>
            Currency
            <input
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              maxLength={3}
              required
            />
          </label>
        </fieldset>

        <AddressBlock legend="Remit to" address={remitTo} onChange={setRemitTo} />

        <fieldset style={fieldset}>
          <legend>Lines</legend>
          {lines.map((l, i) => (
            <div
              key={i}
              style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr) auto', gap: 8 }}
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
                placeholder="Description"
                value={l.description}
                onChange={(e) => updateLine(i, { description: e.target.value })}
                required
              />
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
                type="number"
                placeholder="Unit price"
                value={l.unitPrice}
                onChange={(e) => updateLine(i, { unitPrice: Number(e.target.value) })}
                step="any"
                min="0"
                required
              />
              <input
                placeholder="UoM"
                value={l.unitOfMeasure}
                onChange={(e) => updateLine(i, { unitOfMeasure: e.target.value })}
                required
              />
              <button type="button" onClick={() => removeLine(i)} disabled={lines.length === 1}>
                ×
              </button>
            </div>
          ))}
          <button type="button" onClick={() => setLines((ls) => [...ls, emptyLine()])}>
            + Add line
          </button>
          <p style={{ marginTop: 8 }}>
            <strong>Subtotal:</strong> {subtotal.toFixed(2)} {currency} · <strong>Total:</strong>{' '}
            {total.toFixed(2)} {currency}
          </p>
        </fieldset>

        <label style={label}>
          Notes
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>

        <button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create Invoice (status: DRAFT)'}
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
