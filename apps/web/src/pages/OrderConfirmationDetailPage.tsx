/**
 * ORDER_CONFIRMATION detail page (PHASES.md §2.3).
 *
 * Shared by /buyer/order-confirmation/:id and /supplier/order-confirmation/:id.
 * Shows the response mode, comments, proposed changes (if ACCEPT_WITH_CHANGES),
 * and gives the buyer Accept/Reject buttons when status is ISSUED.
 */

import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type ApiError } from '../api.ts';
import { useMe } from '../auth-state.ts';

interface OcBodyFullAccept {
  mode: 'FULL_ACCEPT';
  poDocumentNumber: string;
  poDocumentId: string;
  comments?: string;
}
interface OcBodyAcceptWithChanges {
  mode: 'ACCEPT_WITH_CHANGES';
  poDocumentNumber: string;
  poDocumentId: string;
  comments?: string;
  proposedChanges: {
    revisedRequestedDeliveryDate?: string;
    revisedLines?: {
      lineRef: string;
      revisedQuantity?: number;
      revisedUnitPrice?: number;
      revisedDeliveryDate?: string;
      comments?: string;
    }[];
  };
}
interface OcBodyReject {
  mode: 'REJECT';
  poDocumentNumber: string;
  poDocumentId: string;
  comments?: string;
}
type OcBody = OcBodyFullAccept | OcBodyAcceptWithChanges | OcBodyReject;

interface DocumentDetail {
  id: string;
  documentNumber: string;
  documentType: string;
  issuerOrgId: string;
  recipientOrgId: string;
  status: string;
  versions: { versionNumber: number; body: unknown }[];
  auditLog: { action: string; occurredAt: string }[];
  outgoingLinks: { toDocumentId: string; linkType: string }[];
}

export function OrderConfirmationDetailPage(): React.ReactElement {
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
  const isBuyer = doc.recipientOrgId === myOrgId;
  const body = doc.versions[doc.versions.length - 1]?.body as OcBody | undefined;

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
        <h2 style={{ margin: 0 }}>ORDER_CONFIRMATION {doc.documentNumber}</h2>
        <Status status={doc.status} />
        {body && <ModeBadge mode={body.mode} />}
      </header>

      {body && (
        <div style={card}>
          <p>
            <strong>Acknowledges PO:</strong>{' '}
            <Link to={(isBuyer ? '/buyer' : '/supplier') + `/po/${body.poDocumentId}`}>
              {body.poDocumentNumber}
            </Link>
          </p>
          {body.comments && (
            <p>
              <strong>Comments:</strong> {body.comments}
            </p>
          )}

          {body.mode === 'ACCEPT_WITH_CHANGES' && (
            <>
              <h3>Proposed changes</h3>
              {body.proposedChanges.revisedRequestedDeliveryDate && (
                <p>
                  <strong>Revised requested delivery:</strong>{' '}
                  {body.proposedChanges.revisedRequestedDeliveryDate}
                </p>
              )}
              {body.proposedChanges.revisedLines &&
                body.proposedChanges.revisedLines.length > 0 && (
                  <table style={{ width: '100%', marginTop: 8 }}>
                    <thead>
                      <tr style={{ background: '#f4f4f4' }}>
                        <th style={th}>Line ref</th>
                        <th style={th}>Revised qty</th>
                        <th style={th}>Revised unit price</th>
                        <th style={th}>Revised delivery</th>
                        <th style={th}>Comments</th>
                      </tr>
                    </thead>
                    <tbody>
                      {body.proposedChanges.revisedLines.map((l, i) => (
                        <tr key={i}>
                          <td style={td}>{l.lineRef}</td>
                          <td style={td}>{l.revisedQuantity ?? '—'}</td>
                          <td style={td}>
                            {l.revisedUnitPrice !== undefined ? l.revisedUnitPrice.toFixed(2) : '—'}
                          </td>
                          <td style={td}>{l.revisedDeliveryDate ?? '—'}</td>
                          <td style={td}>{l.comments ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
            </>
          )}
        </div>
      )}

      {/* Buyer actions on ISSUED order confirmations. ACCEPT_WITH_CHANGES is
          where these matter most — buyer's ACCEPTED_BY_BUYER signals they
          intend to materialise the changes via PO_CHANGE. For FULL_ACCEPT
          and REJECT the buttons are informational. */}
      {isBuyer && doc.status === 'ISSUED' && (
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button
            onClick={() => transition('ACCEPTED_BY_BUYER')}
            disabled={busy}
            style={{ background: '#10b981', color: 'white', border: 'none', padding: '6px 12px' }}
          >
            Accept response
          </button>
          <button
            onClick={() => transition('REJECTED_BY_BUYER')}
            disabled={busy}
            style={{ background: '#ef4444', color: 'white', border: 'none', padding: '6px 12px' }}
          >
            Reject response
          </button>
          {body?.mode === 'ACCEPT_WITH_CHANGES' && (
            <Link
              to={`/buyer/po/${body.poDocumentId}/change`}
              style={{
                background: '#8b5cf6',
                color: 'white',
                padding: '6px 12px',
                textDecoration: 'none',
                borderRadius: 4,
              }}
            >
              + Issue PO change to materialise
            </Link>
          )}
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
    ACCEPTED_BY_BUYER: '#10b981',
    REJECTED_BY_BUYER: '#ef4444',
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

function ModeBadge({ mode }: { mode: OcBody['mode'] }): React.ReactElement {
  const colors: Record<OcBody['mode'], string> = {
    FULL_ACCEPT: '#10b981',
    ACCEPT_WITH_CHANGES: '#f59e0b',
    REJECT: '#ef4444',
  };
  return (
    <span
      style={{
        background: colors[mode],
        color: 'white',
        padding: '4px 10px',
        borderRadius: 4,
        fontSize: 12,
        marginLeft: 8,
      }}
    >
      {mode}
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
