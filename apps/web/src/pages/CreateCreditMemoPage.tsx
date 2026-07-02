/**
 * Supplier-side "Create Credit Memo" form (PHASES.md §2.7).
 *
 * Issued against a previously-published INVOICE. Auto-links CREDITS →
 * INVOICE. Line refs correspond to the invoice's line refs; we pre-fill
 * from the selected invoice's body.
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
  invoiceLineRef: string;
  sku: string;
  description: string;
  creditedQuantity: number;
  unitOfMeasure: string;
  unitPrice: number;
  creditAmount: number;
}

const emptyLine = (): Line => ({
  invoiceLineRef: '',
  sku: '',
  description: '',
  creditedQuantity: 1,
  unitOfMeasure: 'EA',
  unitPrice: 0,
  creditAmount: 0,
});

export function CreateCreditMemoPage(): React.ReactElement {
  const { me } = useMe();
  const navigate = useNavigate();
  const supplierOrgId = me?.activeMembership?.orgId;

  const rels = useEligibleRelationships(supplierOrgId, 'SUPPLIER', 'CREDIT_MEMO');
  const invoices = usePredecessorCandidates('INVOICE', ['ISSUED', 'ACCEPTED_BY_BUYER', 'DISPUTED']);

  const [invoiceId, setInvoiceId] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [reason, setReason] = useState<'RETURN' | 'PRICE_ADJUSTMENT' | 'DAMAGED_GOODS' | 'OTHER'>(
    'RETURN',
  );
  const [reasonDetail, setReasonDetail] = useState('');
  const [issueDate, setIssueDate] = useState(new Date().toISOString().slice(0, 10));
  const [currency, setCurrency] = useState('USD');
  const [remitTo, setRemitTo] = useState(emptyAddress());
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const totalCreditAmount = lines.reduce((acc, l) => acc + (Number(l.creditAmount) || 0), 0);

  useEffect(() => {
    if (!invoiceId) return;
    void api<{
      documentNumber: string;
      currentVersion: {
        body: {
          currency?: string;
          lines?: Array<{
            lineRef?: string;
            sku?: string;
            description?: string;
            quantity?: number;
            unitPrice?: number;
            unitOfMeasure?: string;
          }>;
        };
      } | null;
    }>(`/documents/${invoiceId}`).then((d) => {
      setInvoiceNumber(d.documentNumber);
      const body = d.currentVersion?.body ?? {};
      if (body.currency) setCurrency(body.currency);
      setLines(
        (body.lines ?? []).map((l) => ({
          invoiceLineRef: l.lineRef ?? l.sku ?? '',
          sku: l.sku ?? '',
          description: l.description ?? '',
          creditedQuantity: l.quantity ?? 1,
          unitOfMeasure: l.unitOfMeasure ?? 'EA',
          unitPrice: l.unitPrice ?? 0,
          creditAmount: (l.quantity ?? 1) * (l.unitPrice ?? 0),
        })),
      );
    });
  }, [invoiceId]);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const rel = rels[0];
      const buyerOrgId = rel?.buyerOrgId;
      if (!buyerOrgId) throw new Error('no eligible buyer relationship');
      const result = await api<{ documentId: string }>('/documents', {
        method: 'POST',
        body: JSON.stringify({
          documentType: 'CREDIT_MEMO',
          recipientOrgId: buyerOrgId,
          body: {
            invoiceDocumentNumber: invoiceNumber,
            invoiceDocumentId: invoiceId,
            reason,
            ...(reasonDetail ? { reasonDetail } : {}),
            issueDate,
            currency,
            remitTo,
            lines,
            totalCreditAmount,
            ...(notes ? { notes } : {}),
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
      <h2>Create Credit Memo</h2>
      <form onSubmit={submit} style={gridForm}>
        <fieldset style={fieldset}>
          <legend>Predecessor invoice</legend>
          <label style={label}>
            Invoice
            <select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} required>
              <option value="">(pick one)</option>
              {invoices.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.documentNumber} · {i.status}
                </option>
              ))}
            </select>
          </label>
        </fieldset>

        <fieldset style={fieldset}>
          <legend>Reason</legend>
          <label style={label}>
            Category
            <select
              value={reason}
              onChange={(e) =>
                setReason(
                  e.target.value as 'RETURN' | 'PRICE_ADJUSTMENT' | 'DAMAGED_GOODS' | 'OTHER',
                )
              }
            >
              <option value="RETURN">Return</option>
              <option value="PRICE_ADJUSTMENT">Price adjustment</option>
              <option value="DAMAGED_GOODS">Damaged goods</option>
              <option value="OTHER">Other</option>
            </select>
          </label>
          <label style={label}>
            Detail (optional)
            <input value={reasonDetail} onChange={(e) => setReasonDetail(e.target.value)} />
          </label>
        </fieldset>

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
          <legend>Credit lines</legend>
          {lines.map((l, i) => (
            <div
              key={i}
              style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr) auto', gap: 8 }}
            >
              <input
                placeholder="Invoice lineRef"
                value={l.invoiceLineRef}
                onChange={(e) => updateLine(i, { invoiceLineRef: e.target.value })}
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
                value={l.creditedQuantity}
                onChange={(e) => updateLine(i, { creditedQuantity: Number(e.target.value) })}
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
                type="number"
                placeholder="Credit amount"
                value={l.creditAmount}
                onChange={(e) => updateLine(i, { creditAmount: Number(e.target.value) })}
                step="any"
                min="0"
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
            <strong>Total credit:</strong> {totalCreditAmount.toFixed(2)} {currency}
          </p>
        </fieldset>

        <label style={label}>
          Notes
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>

        <button type="submit" disabled={busy || !invoiceId}>
          {busy ? 'Creating…' : 'Create Credit Memo (status: DRAFT)'}
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
