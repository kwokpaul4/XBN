/**
 * PO detail view. Shows the latest body + status + audit log + lineage,
 * with role-aware transition buttons (e.g. "Issue" for buyer DRAFT,
 * "Acknowledge" for supplier ISSUED, etc.) computed from the §2.1 state machine.
 *
 * Phase 2.2: surfaces incoming SUPERSEDES links so both parties see the
 * pending PO_CHANGE. Buyer also gets an "Issue PO change" button on
 * non-terminal post-DRAFT statuses.
 */

import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type ApiError } from '../api.ts';
import { useMe } from '../auth-state.ts';

interface DocumentDetail {
  id: string;
  documentType: string;
  documentNumber: string;
  issuerOrgId: string;
  recipientOrgId: string;
  status: string;
  versions: {
    versionNumber: number;
    body: unknown;
    createdAt: string;
    changeReason: string | null;
  }[];
  auditLog: { action: string; actorOrgId: string; occurredAt: string; payload: unknown }[];
  outgoingLinks: { toDocumentId: string; linkType: string }[];
  incomingLinks: { fromDocumentId: string; linkType: string }[];
  attachments: {
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
  }[];
}

const BUYER_TRANSITIONS: Record<string, { to: string; label: string }[]> = {
  DRAFT: [
    { to: 'ISSUED', label: 'Issue PO' },
    { to: 'CANCELLED', label: 'Cancel' },
  ],
  ISSUED: [{ to: 'CANCELLED', label: 'Cancel' }],
  ACKNOWLEDGED: [
    { to: 'IN_FULFILLMENT', label: 'Mark in fulfilment' },
    { to: 'CHANGED', label: 'Apply accepted change' },
    { to: 'CANCELLED', label: 'Cancel' },
  ],
  IN_FULFILLMENT: [
    { to: 'CLOSED', label: 'Close PO' },
    { to: 'CHANGED', label: 'Apply accepted change' },
    { to: 'CANCELLED', label: 'Cancel' },
  ],
};

const SUPPLIER_TRANSITIONS: Record<string, { to: string; label: string }[]> = {
  ISSUED: [{ to: 'ACKNOWLEDGED', label: 'Acknowledge' }],
};

/**
 * PO statuses where the buyer is permitted to issue a change. Mirrors the
 * §2.1 state machine: CHANGED is reachable from DRAFT/ISSUED/ACKNOWLEDGED/
 * IN_FULFILLMENT, but in practice the buyer issues a *change document*
 * once the PO is at least ISSUED — there's no point amending a DRAFT.
 */
const PO_CHANGEABLE_STATUSES = new Set(['ISSUED', 'ACKNOWLEDGED', 'IN_FULFILLMENT']);

export function PoDetailPage(): React.ReactElement {
  const { id = '' } = useParams();
  const { me } = useMe();
  const navigate = useNavigate();
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
  const isBuyer = doc.issuerOrgId === myOrgId;
  const transitionsForMe = isBuyer
    ? (BUYER_TRANSITIONS[doc.status] ?? [])
    : (SUPPLIER_TRANSITIONS[doc.status] ?? []);

  const canIssueChange =
    isBuyer && doc.documentType === 'PO' && PO_CHANGEABLE_STATUSES.has(doc.status);

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

  const currentBody = doc.versions[doc.versions.length - 1]?.body as
    | {
        currency?: string;
        paymentTermsRef?: string;
        requestedDeliveryDate?: string;
        shipTo?: { name: string; line1: string; city: string; countryCode: string };
        lines?: {
          sku: string;
          description: string;
          quantity: number;
          unitPrice: number;
          unitOfMeasure: string;
        }[];
      }
    | undefined;

  // Incoming SUPERSEDES links — these are pending or accepted PO_CHANGE
  // documents pointing at this PO. Surfaced so both parties can see them.
  const incomingChanges = doc.incomingLinks.filter((l) => l.linkType === 'SUPERSEDES');

  return (
    <section>
      <header style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>
          {doc.documentType} {doc.documentNumber}
        </h2>
        <Status status={doc.status} />
        <span style={{ marginLeft: 'auto', color: '#666', fontSize: 14 }}>
          {isBuyer ? 'You are the buyer' : 'You are the supplier'}
        </span>
      </header>

      {(transitionsForMe.length > 0 || canIssueChange) && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
          {transitionsForMe.map((t) => (
            <button key={t.to} onClick={() => transition(t.to)} disabled={busy}>
              {t.label}
            </button>
          ))}
          {canIssueChange && (
            <button
              type="button"
              onClick={() => navigate(`/buyer/po/${id}/change`)}
              disabled={busy}
              style={{ background: '#8b5cf6', color: 'white', border: 'none', padding: '6px 12px' }}
            >
              + Issue PO change
            </button>
          )}
        </div>
      )}

      {incomingChanges.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h3>Pending / accepted changes</h3>
          <ul>
            {incomingChanges.map((c) => (
              <li key={c.fromDocumentId}>
                <Link
                  to={
                    isBuyer
                      ? `/buyer/po-change/${c.fromDocumentId}`
                      : `/supplier/po-change/${c.fromDocumentId}`
                  }
                >
                  PO_CHANGE → {c.fromDocumentId.slice(0, 12)}…
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <h3>Body (v{doc.versions.length})</h3>
      <div style={card}>
        <p>
          <strong>Currency:</strong> {currentBody?.currency} · <strong>Terms:</strong>{' '}
          {currentBody?.paymentTermsRef ?? '—'} · <strong>Requested delivery:</strong>{' '}
          {currentBody?.requestedDeliveryDate}
        </p>
        {currentBody?.shipTo && (
          <p>
            <strong>Ship to:</strong> {currentBody.shipTo.name}, {currentBody.shipTo.line1},{' '}
            {currentBody.shipTo.city}, {currentBody.shipTo.countryCode}
          </p>
        )}
        <table style={{ width: '100%', marginTop: 8 }}>
          <thead>
            <tr style={{ background: '#f4f4f4' }}>
              <th style={th}>SKU</th>
              <th style={th}>Description</th>
              <th style={th}>Qty</th>
              <th style={th}>Unit price</th>
              <th style={th}>UoM</th>
              <th style={th}>Line total</th>
            </tr>
          </thead>
          <tbody>
            {(currentBody?.lines ?? []).map((l, i) => (
              <tr key={i}>
                <td style={td}>{l.sku}</td>
                <td style={td}>{l.description}</td>
                <td style={td}>{l.quantity}</td>
                <td style={td}>{l.unitPrice.toFixed(2)}</td>
                <td style={td}>{l.unitOfMeasure}</td>
                <td style={td}>{(l.quantity * l.unitPrice).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Audit log</h3>
      <ul>
        {doc.auditLog.map((a, i) => (
          <li key={i}>
            <code>{new Date(a.occurredAt).toLocaleString()}</code> — {a.action}
          </li>
        ))}
      </ul>

      {doc.versions.length > 1 && (
        <>
          <h3>Version history</h3>
          <ul>
            {doc.versions.map((v) => (
              <li key={v.versionNumber}>
                v{v.versionNumber} · {new Date(v.createdAt).toLocaleString()}
                {v.changeReason && ` — ${v.changeReason}`}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Status({ status }: { status: string }): React.ReactElement {
  const colors: Record<string, string> = {
    DRAFT: '#aaa',
    ISSUED: '#3b82f6',
    ACKNOWLEDGED: '#10b981',
    IN_FULFILLMENT: '#f59e0b',
    CLOSED: '#6b7280',
    CANCELLED: '#ef4444',
    CHANGED: '#8b5cf6',
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
