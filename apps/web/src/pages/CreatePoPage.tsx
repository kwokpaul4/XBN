/**
 * Buyer-side "Create PO" form. Generates a new PO in DRAFT state.
 * Header + dynamic line items with add/remove.
 */

import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type ApiError } from '../api.ts';
import { useMe } from '../auth-state.ts';

interface RelDescriptor {
  id: string;
  buyerOrgId: string;
  supplierOrgId: string;
  status: string;
  enabledDocumentTypes: string[];
}

interface LineForm {
  sku: string;
  description: string;
  quantity: number;
  unitPrice: number;
  unitOfMeasure: string;
}

const emptyLine = (): LineForm => ({
  sku: '',
  description: '',
  quantity: 1,
  unitPrice: 0,
  unitOfMeasure: 'EA',
});

export function CreatePoPage(): React.ReactElement {
  const { me } = useMe();
  const navigate = useNavigate();
  const [rels, setRels] = useState<RelDescriptor[]>([]);
  const [supplierOrgId, setSupplierOrgId] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [paymentTermsRef, setPaymentTermsRef] = useState('NET-30');
  const [requestedDeliveryDate, setRequestedDeliveryDate] = useState('');
  const [shipTo, setShipTo] = useState({
    name: '',
    line1: '',
    city: '',
    countryCode: 'US',
  });
  const [billTo, setBillTo] = useState({
    name: '',
    line1: '',
    city: '',
    countryCode: 'US',
  });
  const [lines, setLines] = useState<LineForm[]>([emptyLine()]);
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const buyerOrgId = me?.activeMembership?.orgId;

  useEffect(() => {
    if (!buyerOrgId) return;
    api<{ relationships: RelDescriptor[] }>('/network/relationships')
      .then((r) => {
        // Only ACTIVE relationships where the active org is the buyer side
        // and PO is enabled.
        const valid = r.relationships.filter(
          (rel) =>
            rel.buyerOrgId === buyerOrgId &&
            rel.status === 'ACTIVE' &&
            rel.enabledDocumentTypes.includes('PO'),
        );
        setRels(valid);
        setSupplierOrgId((prev) => (prev === '' ? (valid[0]?.supplierOrgId ?? '') : prev));
      })
      .catch(() => setRels([]));
  }, [buyerOrgId]);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setErr(null);
    setSubmitting(true);
    try {
      const result = await api<{ documentId: string; documentNumber: string }>('/documents', {
        method: 'POST',
        body: JSON.stringify({
          documentType: 'PO',
          recipientOrgId: supplierOrgId,
          body: {
            currency,
            paymentTermsRef,
            requestedDeliveryDate,
            shipTo,
            billTo,
            lines,
          },
        }),
      });
      navigate(`/buyer/po/${result.documentId}`);
    } catch (caught) {
      const apiErr = caught as ApiError;
      setErr(JSON.stringify(apiErr.body, null, 2));
      setSubmitting(false);
    }
  };

  if (!buyerOrgId) return <p>Set an active org first.</p>;

  return (
    <section>
      <h2>Create Purchase Order</h2>
      {rels.length === 0 && (
        <p style={{ color: '#a00' }}>
          No ACTIVE relationships with PO enabled. Establish one first (currently via API).
        </p>
      )}
      <form onSubmit={submit} style={{ display: 'grid', gap: 16, maxWidth: 720 }}>
        <fieldset style={fieldset}>
          <legend>Header</legend>
          <label style={label}>
            Supplier
            <select
              value={supplierOrgId}
              onChange={(e) => setSupplierOrgId(e.target.value)}
              required
            >
              {rels.map((r) => (
                <option key={r.supplierOrgId} value={r.supplierOrgId}>
                  {r.supplierOrgId}
                </option>
              ))}
            </select>
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
          <label style={label}>
            Payment terms
            <input value={paymentTermsRef} onChange={(e) => setPaymentTermsRef(e.target.value)} />
          </label>
          <label style={label}>
            Requested delivery
            <input
              type="date"
              value={requestedDeliveryDate}
              onChange={(e) => setRequestedDeliveryDate(e.target.value)}
              required
            />
          </label>
        </fieldset>

        <AddressBlock label="Ship to" address={shipTo} onChange={setShipTo} />
        <AddressBlock label="Bill to" address={billTo} onChange={setBillTo} />

        <fieldset style={fieldset}>
          <legend>Lines</legend>
          {lines.map((line, idx) => (
            <div
              key={idx}
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(6, 1fr) auto',
                gap: 8,
                marginBottom: 8,
              }}
            >
              <input
                placeholder="SKU"
                value={line.sku}
                onChange={(e) => updateLine(idx, { sku: e.target.value })}
                required
              />
              <input
                placeholder="Description"
                value={line.description}
                onChange={(e) => updateLine(idx, { description: e.target.value })}
                style={{ gridColumn: 'span 2' }}
                required
              />
              <input
                type="number"
                placeholder="Qty"
                value={line.quantity}
                onChange={(e) => updateLine(idx, { quantity: Number(e.target.value) })}
                step="any"
                min="0.0001"
                required
              />
              <input
                type="number"
                placeholder="Unit price"
                value={line.unitPrice}
                onChange={(e) => updateLine(idx, { unitPrice: Number(e.target.value) })}
                step="any"
                min="0"
                required
              />
              <input
                placeholder="UoM"
                value={line.unitOfMeasure}
                onChange={(e) => updateLine(idx, { unitOfMeasure: e.target.value })}
                required
              />
              <button type="button" onClick={() => removeLine(idx)} disabled={lines.length === 1}>
                ×
              </button>
            </div>
          ))}
          <button type="button" onClick={() => setLines((ls) => [...ls, emptyLine()])}>
            + Add line
          </button>
        </fieldset>

        <button type="submit" disabled={submitting || rels.length === 0}>
          {submitting ? 'Creating…' : 'Create PO (status: DRAFT)'}
        </button>
        {err && <pre style={errStyle}>{err}</pre>}
      </form>
    </section>
  );

  function updateLine(idx: number, patch: Partial<LineForm>): void {
    setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }
  function removeLine(idx: number): void {
    setLines((ls) => ls.filter((_, i) => i !== idx));
  }
}

function AddressBlock({
  label,
  address,
  onChange,
}: {
  label: string;
  address: { name: string; line1: string; city: string; countryCode: string };
  onChange: (a: { name: string; line1: string; city: string; countryCode: string }) => void;
}): React.ReactElement {
  return (
    <fieldset style={fieldset}>
      <legend>{label}</legend>
      <input
        placeholder="Name"
        value={address.name}
        onChange={(e) => onChange({ ...address, name: e.target.value })}
        required
      />
      <input
        placeholder="Address line 1"
        value={address.line1}
        onChange={(e) => onChange({ ...address, line1: e.target.value })}
        required
      />
      <input
        placeholder="City"
        value={address.city}
        onChange={(e) => onChange({ ...address, city: e.target.value })}
        required
      />
      <input
        placeholder="Country (2-letter ISO)"
        value={address.countryCode}
        onChange={(e) => onChange({ ...address, countryCode: e.target.value })}
        maxLength={2}
        required
      />
    </fieldset>
  );
}

const fieldset: React.CSSProperties = {
  border: '1px solid #ddd',
  padding: 12,
  display: 'grid',
  gap: 8,
};
const label: React.CSSProperties = { display: 'grid', gap: 4 };
const errStyle: React.CSSProperties = {
  background: '#fee',
  color: '#900',
  padding: 12,
  whiteSpace: 'pre-wrap',
};
