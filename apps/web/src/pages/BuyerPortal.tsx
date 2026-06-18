import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { useMe } from '../auth-state.ts';

interface RelationshipDescriptor {
  id: string;
  buyerOrgId: string;
  supplierOrgId: string;
  status: string;
  enabledDocumentTypes: string[];
}

interface DocumentRow {
  id: string;
  documentType: string;
  documentNumber: string;
  issuerOrgId: string;
  recipientOrgId: string;
  status: string;
  createdAt: string;
}

export function BuyerPortal(): React.ReactElement {
  const { me } = useMe();
  const [rels, setRels] = useState<RelationshipDescriptor[]>([]);
  const [docs, setDocs] = useState<DocumentRow[]>([]);

  useEffect(() => {
    api<{ relationships: RelationshipDescriptor[] }>('/network/relationships')
      .then((r) => setRels(r.relationships))
      .catch(() => setRels([]));
  }, []);

  useEffect(() => {
    if (!me?.activeMembership) return;
    // Phase 1.4 has no list-documents endpoint yet. Hit /me to confirm
    // the active org is set; deeper inbox is Phase 4.1.
    setDocs([]);
  }, [me?.activeMembership]);

  return (
    <section>
      <h2>Buyer Portal</h2>
      <p>Active org: {me?.activeMembership?.orgId ?? '(none)'}</p>
      <h3>Trading relationships</h3>
      <ul>
        {rels.length === 0 && <li>(no relationships yet)</li>}
        {rels.map((r) => (
          <li key={r.id}>
            <strong>{r.status}</strong> with{' '}
            {r.buyerOrgId === me?.activeMembership?.orgId ? 'supplier' : 'buyer'}{' '}
            {r.buyerOrgId === me?.activeMembership?.orgId ? r.supplierOrgId : r.buyerOrgId} —
            enabled: {r.enabledDocumentTypes.join(', ')}
          </li>
        ))}
      </ul>
      <h3>Documents</h3>
      <ul>{docs.length === 0 && <li>(no documents yet — inbox UI lands in Phase 4.1)</li>}</ul>
      <p style={{ color: '#666', fontSize: 14 }}>
        Phase 1.4 ships the portal shell. Document creation forms, inbox/outbox, and document detail
        views land in Phase 2 (per-document-type) and Phase 4.1 (cross-type inbox/search).
      </p>
    </section>
  );
}
