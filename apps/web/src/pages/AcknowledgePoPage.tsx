/**
 * Supplier-side "Acknowledge PO" form (PHASES.md §2.3).
 *
 * Three response modes:
 *   FULL_ACCEPT          — accept the PO as issued.
 *   ACCEPT_WITH_CHANGES  — accept in principle but propose amendments
 *                          (revised delivery date, revised line quantities/
 *                          prices/dates).
 *   REJECT               — decline the PO.
 *
 * On submit:
 *   1. POST /documents (ORDER_CONFIRMATION) — auto-links ACKNOWLEDGES → PO
 *   2. POST /documents/:ocId/transition (DRAFT → ISSUED)
 *   3. Navigate to the OC detail page for review
 */

import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type ApiError } from '../api.ts';

interface DocDetail {
  id: string;
  documentNumber: string;
  recipientOrgId: string;
  issuerOrgId: string;
  versions: { versionNumber: number; body: unknown }[];
}

interface PoLine {
  sku: string;
  description: string;
  quantity: number;
  unitPrice: number;
  unitOfMeasure: string;
  lineRef?: string;
}

interface PoBody {
  currency: string;
  requestedDeliveryDate: string;
  lines: PoLine[];
}

interface RevisedLine {
  lineRef: string;
  revisedQuantity?: number;
  revisedUnitPrice?: number;
  revisedDeliveryDate?: string;
  comments?: string;
}

type Mode = 'FULL_ACCEPT' | 'ACCEPT_WITH_CHANGES' | 'REJECT';

export function AcknowledgePoPage(): React.ReactElement {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [doc, setDoc] = useState<DocDetail | null>(null);
  const [poBody, setPoBody] = useState<PoBody | null>(null);
  const [mode, setMode] = useState<Mode>('FULL_ACCEPT');
  const [comments, setComments] = useState('');
  const [revisedDeliveryDate, setRevisedDeliveryDate] = useState('');
  const [revisedLines, setRevisedLines] = useState<RevisedLine[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api<DocDetail>(`/documents/${id}`)
      .then((d) => {
        setDoc(d);
        const latest = d.versions[d.versions.length - 1]?.body as PoBody | undefined;
        if (latest) {
          setPoBody(latest);
          // Pre-populate revised-lines slots (one per line) so the supplier
          // can amend any subset.
          setRevisedLines(
            latest.lines.map((l) => ({
              lineRef: l.lineRef ?? l.sku,
            })),
          );
        }
      })
      .catch((e: unknown) => setErr(JSON.stringify(e)));
  }, [id]);

  if (err) return <pre style={errStyle}>{err}</pre>;
  if (!doc || !poBody) return <p>Loading…</p>;

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setErr(null);
    setSubmitting(true);
    try {
      const baseBody = {
        poDocumentNumber: doc.documentNumber,
        poDocumentId: doc.id,
        ...(comments && { comments }),
      };

      let body: unknown;
      if (mode === 'FULL_ACCEPT') {
        body = { mode: 'FULL_ACCEPT', ...baseBody };
      } else if (mode === 'REJECT') {
        body = { mode: 'REJECT', ...baseBody };
      } else {
        // ACCEPT_WITH_CHANGES — collect non-empty revisions
        const filledLines = revisedLines.filter(
          (l) =>
            l.revisedQuantity !== undefined ||
            l.revisedUnitPrice !== undefined ||
            l.revisedDeliveryDate !== undefined ||
            (l.comments !== undefined && l.comments.length > 0),
        );
        const proposedChanges: Record<string, unknown> = {};
        if (revisedDeliveryDate) proposedChanges.revisedRequestedDeliveryDate = revisedDeliveryDate;
        if (filledLines.length > 0) proposedChanges.revisedLines = filledLines;
        body = { mode: 'ACCEPT_WITH_CHANGES', ...baseBody, proposedChanges };
      }

      // 1. Publish OC (auto-links ACKNOWLEDGES → PO)
      const ocRes = await api<{ documentId: string; linkWarning?: unknown }>('/documents', {
        method: 'POST',
        body: JSON.stringify({
          documentType: 'ORDER_CONFIRMATION',
          recipientOrgId: doc.issuerOrgId,
          body,
        }),
      });

      // 2. DRAFT → ISSUED
      await api(`/documents/${ocRes.documentId}/transition`, {
        method: 'POST',
        body: JSON.stringify({ fromStatus: 'DRAFT', toStatus: 'ISSUED' }),
      });

      navigate(`/supplier/order-confirmation/${ocRes.documentId}`);
    } catch (caught) {
      const apiErr = caught as ApiError;
      setErr(JSON.stringify(apiErr.body, null, 2));
      setSubmitting(false);
    }
  };

  const updateRevisedLine = (
    idx: number,
    key: keyof RevisedLine,
    value: string | number | undefined,
  ): void => {
    setRevisedLines((ls) =>
      ls.map((l, i) => {
        if (i !== idx) return l;
        // Build a fresh record by hand — exactOptionalPropertyTypes makes
        // setting an optional field to undefined a type error, so we delete
        // the key in the empty case and assign in the populated case.
        const next = { ...l } as unknown as Record<string, string | number>;
        if (value === undefined || value === '') {
          delete next[key];
        } else {
          next[key] = value;
        }
        return next as unknown as RevisedLine;
      }),
    );
  };

  return (
    <section>
      <h2>Acknowledge PO {doc.documentNumber}</h2>
      <form onSubmit={submit} style={{ display: 'grid', gap: 16, maxWidth: 720 }}>
        <fieldset style={fieldset}>
          <legend>Response mode</legend>
          <label style={radio}>
            <input
              type="radio"
              name="mode"
              checked={mode === 'FULL_ACCEPT'}
              onChange={() => setMode('FULL_ACCEPT')}
            />
            <strong>Full accept</strong> — accept the PO as issued
          </label>
          <label style={radio}>
            <input
              type="radio"
              name="mode"
              checked={mode === 'ACCEPT_WITH_CHANGES'}
              onChange={() => setMode('ACCEPT_WITH_CHANGES')}
            />
            <strong>Accept with changes</strong> — propose amendments
          </label>
          <label style={radio}>
            <input
              type="radio"
              name="mode"
              checked={mode === 'REJECT'}
              onChange={() => setMode('REJECT')}
            />
            <strong>Reject</strong> — decline the PO
          </label>
        </fieldset>

        <fieldset style={fieldset}>
          <legend>Comments (optional)</legend>
          <textarea
            value={comments}
            onChange={(e) => setComments(e.target.value)}
            rows={3}
            placeholder="Free-form note to the buyer"
          />
        </fieldset>

        {mode === 'ACCEPT_WITH_CHANGES' && (
          <fieldset style={fieldset}>
            <legend>Proposed changes</legend>
            <p style={{ color: '#666', fontSize: 13, margin: 0 }}>
              At least one of revised delivery date or per-line revisions is required.
            </p>
            <label style={label}>
              Revised requested delivery date (whole order)
              <input
                type="date"
                value={revisedDeliveryDate}
                onChange={(e) => setRevisedDeliveryDate(e.target.value)}
              />
            </label>
            <h4>Per-line revisions</h4>
            {poBody.lines.map((line, idx) => (
              <div
                key={idx}
                style={{
                  border: '1px solid #eee',
                  padding: 8,
                  marginBottom: 8,
                  borderRadius: 4,
                  background: '#fafafa',
                }}
              >
                <strong>{line.sku}</strong> — {line.description} (orig: {line.quantity}{' '}
                {line.unitOfMeasure} @ {line.unitPrice.toFixed(2)})
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(3, 1fr)',
                    gap: 8,
                    marginTop: 8,
                  }}
                >
                  <label style={label}>
                    Revised qty
                    <input
                      type="number"
                      step="any"
                      min="0.0001"
                      value={revisedLines[idx]?.revisedQuantity ?? ''}
                      onChange={(e) =>
                        updateRevisedLine(
                          idx,
                          'revisedQuantity',
                          e.target.value === '' ? undefined : Number(e.target.value),
                        )
                      }
                    />
                  </label>
                  <label style={label}>
                    Revised unit price
                    <input
                      type="number"
                      step="any"
                      min="0"
                      value={revisedLines[idx]?.revisedUnitPrice ?? ''}
                      onChange={(e) =>
                        updateRevisedLine(
                          idx,
                          'revisedUnitPrice',
                          e.target.value === '' ? undefined : Number(e.target.value),
                        )
                      }
                    />
                  </label>
                  <label style={label}>
                    Revised delivery
                    <input
                      type="date"
                      value={revisedLines[idx]?.revisedDeliveryDate ?? ''}
                      onChange={(e) =>
                        updateRevisedLine(
                          idx,
                          'revisedDeliveryDate',
                          e.target.value === '' ? undefined : e.target.value,
                        )
                      }
                    />
                  </label>
                </div>
                <input
                  placeholder="Comments for this line"
                  value={revisedLines[idx]?.comments ?? ''}
                  onChange={(e) =>
                    updateRevisedLine(
                      idx,
                      'comments',
                      e.target.value === '' ? undefined : e.target.value,
                    )
                  }
                  style={{ marginTop: 6, width: '100%' }}
                />
              </div>
            ))}
          </fieldset>
        )}

        <button type="submit" disabled={submitting}>
          {submitting ? 'Submitting…' : 'Submit acknowledgement'}
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
const radio: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center' };
const errStyle: React.CSSProperties = {
  background: '#fee',
  color: '#900',
  padding: 12,
  whiteSpace: 'pre-wrap',
};
