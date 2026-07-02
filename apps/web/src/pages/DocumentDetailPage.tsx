/**
 * Doc-type-agnostic detail page. Renders the full document envelope for
 * any type that doesn't have a bespoke detail page — body JSON, versions,
 * incoming/outgoing links, audit log, attachments.
 *
 * Used for ASN, GOODS_RECEIPT, INVOICE, CREDIT_MEMO, REMITTANCE_ADVICE,
 * and every Phase 3 SCC type. PO / PO_CHANGE / ORDER_CONFIRMATION keep
 * their bespoke pages because they have role-specific action buttons.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type ApiError } from '../api.ts';
import { useMe } from '../auth-state.ts';

interface DocumentEnvelope {
  id: string;
  documentType: string;
  documentNumber: string;
  status: string;
  issuerOrgId: string;
  recipientOrgId: string;
  createdAt: string;
  updatedAt: string;
  currentVersion: { id: string; versionNumber: number; body: unknown } | null;
  versions: Array<{ id: string; versionNumber: number; body: unknown; createdAt: string }>;
  outgoingLinks: Array<{ linkType: string; toDocumentId: string }>;
  incomingLinks: Array<{ linkType: string; fromDocumentId: string }>;
  auditLog: Array<{ action: string; occurredAt: string; actorUserId: string | null }>;
  attachments: Array<{
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
  }>;
}

const TRANSITIONS: Record<string, Array<{ from: string; to: string }>> = {
  ASN: [
    { from: 'DRAFT', to: 'ISSUED' },
    { from: 'ISSUED', to: 'IN_TRANSIT' },
    { from: 'IN_TRANSIT', to: 'DELIVERED' },
    { from: 'ISSUED', to: 'CANCELLED' },
  ],
  INVOICE: [
    { from: 'DRAFT', to: 'ISSUED' },
    { from: 'ISSUED', to: 'ACCEPTED_BY_BUYER' },
    { from: 'ISSUED', to: 'DISPUTED' },
  ],
  CREDIT_MEMO: [
    { from: 'DRAFT', to: 'ISSUED' },
    { from: 'ISSUED', to: 'ACCEPTED_BY_BUYER' },
  ],
  SCHEDULING_AGREEMENT: [
    { from: 'DRAFT', to: 'ACTIVE' },
    { from: 'DRAFT', to: 'CANCELLED' },
    { from: 'ACTIVE', to: 'SUSPENDED' },
    { from: 'ACTIVE', to: 'TERMINATED' },
    { from: 'SUSPENDED', to: 'ACTIVE' },
    { from: 'SUSPENDED', to: 'TERMINATED' },
  ],
  CONSIGNMENT_CONTRACT: [
    { from: 'DRAFT', to: 'ACTIVE' },
    { from: 'ACTIVE', to: 'SUSPENDED' },
    { from: 'ACTIVE', to: 'TERMINATED' },
    { from: 'SUSPENDED', to: 'ACTIVE' },
    { from: 'SUSPENDED', to: 'TERMINATED' },
  ],
  SUBCONTRACTING_AGREEMENT: [
    { from: 'DRAFT', to: 'ACTIVE' },
    { from: 'ACTIVE', to: 'SUSPENDED' },
    { from: 'ACTIVE', to: 'TERMINATED' },
    { from: 'SUSPENDED', to: 'ACTIVE' },
    { from: 'SUSPENDED', to: 'TERMINATED' },
  ],
  FORECAST_PUBLISH: [{ from: 'DRAFT', to: 'ISSUED' }],
  FORECAST_COMMIT: [{ from: 'DRAFT', to: 'ISSUED' }],
  SA_RELEASE_FORECAST: [{ from: 'DRAFT', to: 'ISSUED' }],
  SA_RELEASE_JIT: [{ from: 'DRAFT', to: 'ISSUED' }],
  GOODS_RECEIPT: [], // POSTED is terminal
  REMITTANCE_ADVICE: [], // ISSUED is terminal
};

export function DocumentDetailPage(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const { me } = useMe();
  const navigate = useNavigate();
  const [doc, setDoc] = useState<DocumentEnvelope | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    if (!id) return;
    try {
      const d = await api<DocumentEnvelope>(`/documents/${id}`);
      setDoc(d);
    } catch (caught) {
      setErr(JSON.stringify((caught as ApiError).body, null, 2));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (err) return <pre style={{ background: '#fee', padding: 12 }}>{err}</pre>;
  if (!doc) return <p>Loading…</p>;

  const activeOrgId = me?.activeMembership?.orgId;
  const isIssuer = activeOrgId === doc.issuerOrgId;
  const isRecipient = activeOrgId === doc.recipientOrgId;
  const availableTransitions = (TRANSITIONS[doc.documentType] ?? []).filter(
    (t) => t.from === doc.status,
  );

  async function transition(from: string, to: string): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      await api(`/documents/${doc!.id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ fromStatus: from, toStatus: to }),
      });
      await load();
    } catch (caught) {
      setErr(JSON.stringify((caught as ApiError).body, null, 2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
        <h2 style={{ margin: 0 }}>
          {doc.documentType} · {doc.documentNumber}
        </h2>
        <span style={statusChip(doc.status)}>{doc.status}</span>
      </div>
      <p style={{ color: '#666' }}>
        Issuer: {doc.issuerOrgId} → Recipient: {doc.recipientOrgId} · created{' '}
        {new Date(doc.createdAt).toLocaleString()}
      </p>

      {availableTransitions.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          {availableTransitions.map((t) => (
            <button
              key={`${t.from}-${t.to}`}
              onClick={() => void transition(t.from, t.to)}
              disabled={busy}
            >
              {t.from} → {t.to}
            </button>
          ))}
        </div>
      )}

      <details open>
        <summary>
          <strong>Body</strong> (version {doc.currentVersion?.versionNumber ?? '?'})
        </summary>
        <pre style={jsonStyle}>{JSON.stringify(doc.currentVersion?.body ?? {}, null, 2)}</pre>
      </details>

      <details>
        <summary>
          <strong>Lineage</strong> ({doc.outgoingLinks.length} outgoing, {doc.incomingLinks.length}{' '}
          incoming)
        </summary>
        <table style={{ width: '100%', fontSize: 13 }}>
          <thead>
            <tr>
              <th align="left">Direction</th>
              <th align="left">linkType</th>
              <th align="left">Other document</th>
            </tr>
          </thead>
          <tbody>
            {doc.outgoingLinks.map((l, i) => (
              <tr key={`o-${i}`}>
                <td>out →</td>
                <td>{l.linkType}</td>
                <td>
                  <Link to={`/documents/${l.toDocumentId}`}>{l.toDocumentId}</Link>
                </td>
              </tr>
            ))}
            {doc.incomingLinks.map((l, i) => (
              <tr key={`i-${i}`}>
                <td>in ←</td>
                <td>{l.linkType}</td>
                <td>
                  <Link to={`/documents/${l.fromDocumentId}`}>{l.fromDocumentId}</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <details>
        <summary>
          <strong>Versions</strong> ({doc.versions.length})
        </summary>
        {doc.versions.map((v) => (
          <div key={v.id} style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 'bold' }}>
              v{v.versionNumber} — {new Date(v.createdAt).toLocaleString()}
            </div>
            <pre style={jsonStyle}>{JSON.stringify(v.body, null, 2)}</pre>
          </div>
        ))}
      </details>

      <details>
        <summary>
          <strong>Audit log</strong> ({doc.auditLog.length} entries)
        </summary>
        <ul>
          {doc.auditLog.map((e, i) => (
            <li key={i}>
              <code>{e.action}</code> · {new Date(e.occurredAt).toLocaleString()}
              {e.actorUserId && ` · ${e.actorUserId}`}
            </li>
          ))}
        </ul>
      </details>

      <p style={{ marginTop: 24 }}>
        {isIssuer && <em>You are the issuer.</em>}
        {isRecipient && <em>You are the recipient.</em>}
      </p>
      <button onClick={() => navigate(-1)}>← Back</button>
    </section>
  );
}

function statusChip(status: string): React.CSSProperties {
  const terminal = ['CLOSED', 'CANCELLED', 'TERMINATED', 'DELIVERED', 'ACCEPTED_BY_BUYER'];
  return {
    background: terminal.includes(status) ? '#e6f4ea' : '#eef',
    color: '#333',
    padding: '2px 8px',
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 'bold',
  };
}

const jsonStyle: React.CSSProperties = {
  background: '#f5f5f5',
  padding: 12,
  fontSize: 12,
  overflowX: 'auto',
  maxHeight: 400,
};
