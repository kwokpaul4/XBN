/**
 * Buyer-side "Create Scheduling Agreement" form (PHASES.md §3 anchor).
 *
 * Long-lived contract (validity in years) that anchors forecast +
 * release choreography. Single-item SA per MVP.
 */

import React, { useState } from 'react';
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
} from './DocumentFormHelpers.tsx';

export function CreateSchedulingAgreementPage(): React.ReactElement {
  const { me } = useMe();
  const navigate = useNavigate();
  const buyerOrgId = me?.activeMembership?.orgId;

  const rels = useEligibleRelationships(buyerOrgId, 'BUYER', 'SCHEDULING_AGREEMENT');
  const [supplierOrgId, setSupplierOrgId] = useState('');

  const [itemSku, setItemSku] = useState('');
  const [itemDescription, setItemDescription] = useState('');
  const [targetQuantity, setTargetQuantity] = useState(1000);
  const [unitOfMeasure, setUnitOfMeasure] = useState('EA');
  const [unitPrice, setUnitPrice] = useState(0);
  const [currency, setCurrency] = useState('USD');
  const [validityStart, setValidityStart] = useState('');
  const [validityEnd, setValidityEnd] = useState('');
  const [plant, setPlant] = useState('PLANT-001');
  const [shipTo, setShipTo] = useState(emptyAddress());
  const [paymentTermsRef, setPaymentTermsRef] = useState('NET-30');
  const [incoterms, setIncoterms] = useState('FOB');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const recipient = supplierOrgId || rels[0]?.supplierOrgId;
      if (!recipient) throw new Error('no eligible supplier relationship');
      const result = await api<{ documentId: string }>('/documents', {
        method: 'POST',
        body: JSON.stringify({
          documentType: 'SCHEDULING_AGREEMENT',
          recipientOrgId: recipient,
          body: {
            itemSku,
            itemDescription,
            targetQuantity,
            unitOfMeasure,
            unitPrice,
            currency,
            validityStart,
            validityEnd,
            plant,
            shipTo,
            paymentTermsRef,
            incoterms,
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
      <h2>Create Scheduling Agreement</h2>
      {rels.length === 0 && (
        <p style={{ color: '#a00' }}>
          No ACTIVE relationships with SCHEDULING_AGREEMENT enabled from this buyer org.
        </p>
      )}
      <form onSubmit={submit} style={gridForm}>
        <fieldset style={fieldset}>
          <legend>Supplier</legend>
          <label style={label}>
            Supplier
            <select
              value={supplierOrgId}
              onChange={(e) => setSupplierOrgId(e.target.value)}
              required
            >
              <option value="">(pick one)</option>
              {rels.map((r) => (
                <option key={r.supplierOrgId} value={r.supplierOrgId}>
                  {r.supplierOrgId}
                </option>
              ))}
            </select>
          </label>
        </fieldset>

        <fieldset style={fieldset}>
          <legend>Item</legend>
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
            Target quantity
            <input
              type="number"
              value={targetQuantity}
              onChange={(e) => setTargetQuantity(Number(e.target.value))}
              step="any"
              min="0.0001"
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
            Unit price
            <input
              type="number"
              value={unitPrice}
              onChange={(e) => setUnitPrice(Number(e.target.value))}
              step="any"
              min="0"
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
          <legend>Validity + terms</legend>
          <label style={label}>
            Validity start
            <input
              type="date"
              value={validityStart}
              onChange={(e) => setValidityStart(e.target.value)}
              required
            />
          </label>
          <label style={label}>
            Validity end
            <input
              type="date"
              value={validityEnd}
              onChange={(e) => setValidityEnd(e.target.value)}
              required
            />
          </label>
          <label style={label}>
            Plant
            <input value={plant} onChange={(e) => setPlant(e.target.value)} required />
          </label>
          <label style={label}>
            Payment terms
            <input value={paymentTermsRef} onChange={(e) => setPaymentTermsRef(e.target.value)} />
          </label>
          <label style={label}>
            Incoterms
            <input value={incoterms} onChange={(e) => setIncoterms(e.target.value)} />
          </label>
        </fieldset>

        <AddressBlock legend="Ship to (plant)" address={shipTo} onChange={setShipTo} />

        <button type="submit" disabled={busy || rels.length === 0}>
          {busy ? 'Creating…' : 'Create Scheduling Agreement (status: DRAFT)'}
        </button>
        {err && <pre style={errStyle}>{err}</pre>}
      </form>
    </section>
  );
}
