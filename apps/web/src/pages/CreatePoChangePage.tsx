/**
 * Buyer-side "Issue PO Change" form. Pre-fills from the latest PO body
 * so the buyer edits-in-place rather than typing the whole thing again.
 *
 * On submit:
 *   1. POST /documents (PO_CHANGE) with the revised body
 *   2. POST /documents/:changeId/links (SUPERSEDES → original PO)
 *   3. POST /documents/:changeId/transition (DRAFT → ISSUED)
 *
 * If any step fails, we surface the error and keep the user on the form.
 * Steps 2 and 3 are best-effort follow-ups to step 1 — if step 1 succeeded
 * the change document exists, just unlinked / still in DRAFT.
 */

import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type ApiError } from '../api.ts';

interface LineForm {
  sku: string;
  description: string;
  quantity: number;
  unitPrice: number;
  unitOfMeasure: string;
}

interface AddressForm {
  name: string;
  line1: string;
  city: string;
  countryCode: string;
}

interface DocDetail {
  id: string;
  documentNumber: string;
  status: string;
  recipientOrgId: string;
  versions: { versionNumber: number; body: unknown }[];
}

interface PoBody {
  currency: string;
  paymentTermsRef?: string;
  requestedDeliveryDate: string;
  shipTo: AddressForm;
  billTo: AddressForm;
  lines: LineForm[];
}

export function CreatePoChangePage(): React.ReactElement {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [doc, setDoc] = useState<DocDetail | null>(null);
  const [body, setBody] = useState<PoBody | null>(null);
  const [changeReason, setChangeReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api<DocDetail>(`/documents/${id}`)
      .then((d) => {
        setDoc(d);
        const latest = d.versions[d.versions.length - 1]?.body as PoBody | undefined;
        if (latest) setBody({ ...latest, lines: latest.lines.map((l) => ({ ...l })) });
      })
      .catch((e: unknown) => setErr(JSON.stringify(e)));
  }, [id]);

  if (err) return <pre style={errStyle}>{err}</pre>;
  if (!doc || !body) return <p>Loading…</p>;

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setErr(null);
    setSubmitting(true);
    try {
      // 1. Publish PO_CHANGE
      const changeRes = await api<{ documentId: string }>('/documents', {
        method: 'POST',
        body: JSON.stringify({
          documentType: 'PO_CHANGE',
          recipientOrgId: doc.recipientOrgId,
          body: {
            poDocumentNumber: doc.documentNumber,
            poDocumentId: doc.id,
            changeReason,
            revisedBody: body,
          },
        }),
      });
      const changeId = changeRes.documentId;

      // 2. Link SUPERSEDES → original PO
      await api(`/documents/${changeId}/links`, {
        method: 'POST',
        body: JSON.stringify({
          toDocumentId: doc.id,
          toDocumentType: 'PO',
          linkType: 'SUPERSEDES',
        }),
      });

      // 3. Transition PO_CHANGE: DRAFT → ISSUED
      await api(`/documents/${changeId}/transition`, {
        method: 'POST',
        body: JSON.stringify({ fromStatus: 'DRAFT', toStatus: 'ISSUED' }),
      });

      // Done — go back to the original PO detail.
      navigate(`/buyer/po/${doc.id}`);
    } catch (caught) {
      const apiErr = caught as ApiError;
      setErr(JSON.stringify(apiErr.body, null, 2));
      setSubmitting(false);
    }
  };

  const updateLine = (idx: number, patch: Partial<LineForm>): void => {
    setBody((prev) =>
      prev
        ? { ...prev, lines: prev.lines.map((l, i) => (i === idx ? { ...l, ...patch } : l)) }
        : prev,
    );
  };

  return (
    <section>
      <h2>Issue PO Change · {doc.documentNumber}</h2>
      <p style={{ color: '#666' }}>
        Revise the PO body below and add a change reason. The supplier will see the change and
        accept or reject it. The original PO advances to <code>CHANGED</code> only after the
        supplier accepts.
      </p>
      <form onSubmit={submit} style={{ display: 'grid', gap: 16, maxWidth: 720 }}>
        <fieldset style={fieldset}>
          <legend>Change reason</legend>
          <input
            placeholder="e.g. quantity increased, delivery delayed by 1 week"
            value={changeReason}
            onChange={(e) => setChangeReason(e.target.value)}
            required
            minLength={1}
          />
        </fieldset>

        <fieldset style={fieldset}>
          <legend>Header</legend>
          <label style={label}>
            Currency
            <input
              value={body.currency}
              onChange={(e) => setBody({ ...body, currency: e.target.value })}
              maxLength={3}
              required
            />
          </label>
          <label style={label}>
            Payment terms
            <input
              value={body.paymentTermsRef ?? ''}
              onChange={(e) => setBody({ ...body, paymentTermsRef: e.target.value })}
            />
          </label>
          <label style={label}>
            Requested delivery
            <input
              type="date"
              value={body.requestedDeliveryDate}
              onChange={(e) => setBody({ ...body, requestedDeliveryDate: e.target.value })}
              required
            />
          </label>
        </fieldset>

        <fieldset style={fieldset}>
          <legend>Lines</legend>
          {body.lines.map((line, idx) => (
            <div
              key={idx}
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(5, 1fr)',
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
            </div>
          ))}
        </fieldset>

        <button type="submit" disabled={submitting}>
          {submitting ? 'Issuing change…' : 'Issue PO Change'}
        </button>
        {err && <pre style={errStyle}>{err}</pre>}
      </form>
    </section>
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
