/**
 * Buyer-side "Create Remittance Advice" form (PHASES.md §2.8).
 *
 * NOTIFICATION-ONLY document. XBN does not move money — this document
 * lets the supplier reconcile against the payment the buyer's ERP/AP
 * system actually made. We list one allocation row per invoice / credit
 * memo the payment covers.
 *
 * Auto-links REMITS → each allocation's document.
 */

import React, { useState } from 'react';
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

interface Allocation {
  documentType: 'INVOICE' | 'CREDIT_MEMO';
  documentId: string;
  documentNumber: string;
  appliedAmount: number;
}

export function CreateRemittancePage(): React.ReactElement {
  const { me } = useMe();
  const navigate = useNavigate();
  const buyerOrgId = me?.activeMembership?.orgId;

  const rels = useEligibleRelationships(buyerOrgId, 'BUYER', 'REMITTANCE_ADVICE');
  const invoices = usePredecessorCandidates('INVOICE', ['ISSUED', 'ACCEPTED_BY_BUYER']);
  const creditMemos = usePredecessorCandidates('CREDIT_MEMO', ['ISSUED', 'ACCEPTED_BY_BUYER']);

  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().slice(0, 10));
  const [paymentMethod, setPaymentMethod] = useState<'WIRE' | 'ACH' | 'CHECK' | 'OTHER'>('ACH');
  const [paymentReference, setPaymentReference] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const totalPaymentAmount = allocations.reduce(
    (acc, a) => acc + (Number(a.appliedAmount) || 0),
    0,
  );

  function toggleInvoice(id: string, docNum: string): void {
    setAllocations((prev) => {
      const found = prev.find((a) => a.documentId === id);
      if (found) return prev.filter((a) => a.documentId !== id);
      return [
        ...prev,
        { documentType: 'INVOICE', documentId: id, documentNumber: docNum, appliedAmount: 0 },
      ];
    });
  }

  function toggleCreditMemo(id: string, docNum: string): void {
    setAllocations((prev) => {
      const found = prev.find((a) => a.documentId === id);
      if (found) return prev.filter((a) => a.documentId !== id);
      return [
        ...prev,
        { documentType: 'CREDIT_MEMO', documentId: id, documentNumber: docNum, appliedAmount: 0 },
      ];
    });
  }

  function setAmount(id: string, amount: number): void {
    setAllocations((prev) =>
      prev.map((a) => (a.documentId === id ? { ...a, appliedAmount: amount } : a)),
    );
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const rel = rels[0];
      const supplierOrgId = rel?.supplierOrgId;
      if (!supplierOrgId) throw new Error('no eligible supplier relationship');
      if (allocations.length === 0) throw new Error('pick at least one invoice or credit memo');
      const result = await api<{ documentId: string }>('/documents', {
        method: 'POST',
        body: JSON.stringify({
          documentType: 'REMITTANCE_ADVICE',
          recipientOrgId: supplierOrgId,
          body: {
            paymentDate,
            paymentMethod,
            paymentReference,
            currency,
            totalPaymentAmount,
            allocations,
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

  if (!buyerOrgId) return <p>Set an active org first.</p>;

  return (
    <section>
      <h2>Create Remittance Advice</h2>
      <p style={{ color: '#666', fontSize: 12, maxWidth: 720 }}>
        <strong>Notification only.</strong> XBN does not move money — this document lets the
        supplier reconcile against the payment your ERP/AP system actually made.
      </p>
      <form onSubmit={submit} style={gridForm}>
        <fieldset style={fieldset}>
          <legend>Payment header</legend>
          <label style={label}>
            Payment date
            <input
              type="date"
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
              required
            />
          </label>
          <label style={label}>
            Payment method
            <select
              value={paymentMethod}
              onChange={(e) =>
                setPaymentMethod(e.target.value as 'WIRE' | 'ACH' | 'CHECK' | 'OTHER')
              }
            >
              <option value="WIRE">Wire</option>
              <option value="ACH">ACH</option>
              <option value="CHECK">Check</option>
              <option value="OTHER">Other</option>
            </select>
          </label>
          <label style={label}>
            External payment reference (wire id / check # / ACH trace)
            <input
              value={paymentReference}
              onChange={(e) => setPaymentReference(e.target.value)}
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

        <fieldset style={fieldset}>
          <legend>Invoices paid</legend>
          {invoices.length === 0 && <em>(no eligible invoices)</em>}
          {invoices.map((inv) => {
            const alloc = allocations.find((a) => a.documentId === inv.id);
            return (
              <div
                key={inv.id}
                style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 140px', gap: 8 }}
              >
                <input
                  type="checkbox"
                  checked={!!alloc}
                  onChange={() => toggleInvoice(inv.id, inv.documentNumber)}
                />
                <span>
                  {inv.documentNumber} · <em>{inv.status}</em>
                </span>
                <input
                  type="number"
                  disabled={!alloc}
                  placeholder="Amount"
                  value={alloc?.appliedAmount ?? 0}
                  onChange={(e) => setAmount(inv.id, Number(e.target.value))}
                  step="any"
                  min="0"
                />
              </div>
            );
          })}
        </fieldset>

        <fieldset style={fieldset}>
          <legend>Credit memos applied</legend>
          {creditMemos.length === 0 && <em>(no credit memos yet)</em>}
          {creditMemos.map((cm) => {
            const alloc = allocations.find((a) => a.documentId === cm.id);
            return (
              <div
                key={cm.id}
                style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 140px', gap: 8 }}
              >
                <input
                  type="checkbox"
                  checked={!!alloc}
                  onChange={() => toggleCreditMemo(cm.id, cm.documentNumber)}
                />
                <span>
                  {cm.documentNumber} · <em>{cm.status}</em>
                </span>
                <input
                  type="number"
                  disabled={!alloc}
                  placeholder="Amount"
                  value={alloc?.appliedAmount ?? 0}
                  onChange={(e) => setAmount(cm.id, Number(e.target.value))}
                  step="any"
                  min="0"
                />
              </div>
            );
          })}
        </fieldset>

        <p>
          <strong>Total payment:</strong> {totalPaymentAmount.toFixed(2)} {currency}
        </p>

        <label style={label}>
          Notes
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>

        <button type="submit" disabled={busy || allocations.length === 0}>
          {busy ? 'Creating…' : 'Send Remittance Advice'}
        </button>
        {err && <pre style={errStyle}>{err}</pre>}
      </form>
    </section>
  );
}
