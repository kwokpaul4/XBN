/**
 * PO_CHANGE detail. Shows the change reason, the revised PO body, and
 * (for the supplier) Accept/Reject buttons when the change is in ISSUED.
 *
 * Used by both /buyer/po-change/:id and /supplier/po-change/:id — the
 * routes share this component; role-aware UI keys off issuer/recipient.
 */

import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type ApiError } from '../api.ts';
import { useMe } from '../auth-state.ts';

interface ChangeBody {
  poDocumentNumber: string;
  poDocumentId: string;
  changeReason: string;
  affectedLineRefs?: string[];
  revisedBody: {
    currency: string;
    paymentTermsRef?: string;
    requestedDeliveryDate: string;
    shipTo: { name: string; line1: string; city: string; countryCode: string };
    billTo: { name: string; line1: string; city: string; countryCode: string };
    lines: {
      sku: string;
      description: string;
      quantity: number;
      unitPrice: number;
      unitOfMeasure: string;
    }[];
  };
}

interface DocumentDetail {
  id: string;
  documentType: string;
  documentNumber: string;
  issuerOrgId: string;
  recipientOrgId: string;
  status: string;
  versions: { versionNumber: number; body: unknown; createdAt: string }[];
  auditLog: { action: string; occurredAt: string }[];
  outgoingLinks: { toDocumentId: string; linkType: string }[];
  incomingLinks: { fromDocumentId: string; linkType: string }[];
}

export function PoChangeDetailPage(): React.ReactElement {
  const { id = '' } = useParams();
  const { me } = useMe();
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<DocumentDetail>(`/documents/${id}`)
      .then((d) => setDoc(d))
      .catch((e: unknown) => setErr(JSON.stringify(e)));
  }, [id]);

  const reload = (): void => {
    api<DocumentDetail>(`/documents/${id}`)
      .then((d) => setDoc(d))
      .catch((e: unknown) => setErr(JSON.stringify(e)));
  };

  if (err) return <pre style={errStyle}>{err}</pre>;
  if (!doc) return <p>Loading…</p>;

  const myOrgId = me?.activeMembership?.orgId;
  const isSupplier = doc.recipientOrgId === myOrgId;
  const body = doc.versions[doc.versions.length - 1]?.body as ChangeBody | undefined;

  const transition = async (toStatus: string): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/documents/${id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ fromStatus: doc.status, toStatus }),
      });
      reload();
    } catch (caught) {
      const apiErr = caught as ApiError;
      setErr(JSON.stringify(apiErr.body, null, 2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <header style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>
          {doc.documentType} {doc.documentNumber}
        </h2>
        <Status status={doc.status} />
      </header>

      {body && (
        <div style={card}>
          <p>
            <strong>Amends PO:</strong>{' '}
            <Link to={(isSupplier ? '/supplier' : '/buyer') + `/po/${body.poDocumentId}`}>
              {body.poDocumentNumber}
            </Link>
          </p>
          <p>
            <strong>Change reason:</strong> {body.changeReason}
          </p>
          {body.affectedLineRefs && body.affectedLineRefs.length > 0 && (
            <p>
              <strong>Affected lines:</strong> {body.affectedLineRefs.join(', ')}
            </p>
          )}

          <h3>Revised PO body</h3>
          <p>
            <strong>Currency:</strong> {body.revisedBody.currency} · <strong>Terms:</strong>{' '}
            {body.revisedBody.paymentTermsRef ?? '—'} · <strong>Requested delivery:</strong>{' '}
            {body.revisedBody.requestedDeliveryDate}
          </p>
          <table style={{ width: '100%', marginTop: 8 }}>
            <thead>
              <tr style={{ background: '#f4f4f4' }}>
                <th style={th}>SKU</th>
                <th style={th}>Description</th>
                <th style={th}>Qty</th>
                <th style={th}>Unit price</th>
                <th style={th}>UoM</th>
              </tr>
            </thead>
            <tbody>
              {body.revisedBody.lines.map((l, i) => (
                <tr key={i}>
                  <td style={td}>{l.sku}</td>
                  <td style={td}>{l.description}</td>
                  <td style={td}>{l.quantity}</td>
                  <td style={td}>{l.unitPrice.toFixed(2)}</td>
                  <td style={td}>{l.unitOfMeasure}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {isSupplier && doc.status === 'ISSUED' && (
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button
            onClick={() => transition('ACCEPTED_BY_SUPPLIER')}
            disabled={busy}
            style={{ background: '#10b981', color: 'white', border: 'none', padding: '6px 12px' }}
          >
            Accept change
          </button>
          <button
            onClick={() => transition('REJECTED_BY_SUPPLIER')}
            disabled={busy}
            style={{ background: '#ef4444', color: 'white', border: 'none', padding: '6px 12px' }}
          >
            Reject change
          </button>
        </div>
      )}

      <h3 style={{ marginTop: 24 }}>Audit log</h3>
      <ul>
        {doc.auditLog.map((a, i) => (
          <li key={i}>
            <code>{new Date(a.occurredAt).toLocaleString()}</code> — {a.action}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Status({ status }: { status: string }): React.ReactElement {
  const colors: Record<string, string> = {
    DRAFT: '#aaa',
    ISSUED: '#3b82f6',
    ACCEPTED_BY_SUPPLIER: '#10b981',
    REJECTED_BY_SUPPLIER: '#ef4444',
  };
  return (
    <span
      style={{
        background: colors[status] ?? '#999',
        color: 'white',
        padding: '4px 10px',
        borderRadius: 4,
        fontSize: 13,
      }}
    >
      {status}
    </span>
  );
}

const card: React.CSSProperties = {
  border: '1px solid #ddd',
  padding: 12,
  borderRadius: 4,
  background: '#fafafa',
};
const th: React.CSSProperties = { textAlign: 'left', padding: 6, borderBottom: '1px solid #ddd' };
const td: React.CSSProperties = { padding: 6, borderBottom: '1px solid #eee' };
const errStyle: React.CSSProperties = {
  background: '#fee',
  color: '#900',
  padding: 12,
  whiteSpace: 'pre-wrap',
};
