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

export function SupplierPortal(): React.ReactElement {
  const { me } = useMe();
  const [rels, setRels] = useState<RelationshipDescriptor[]>([]);

  useEffect(() => {
    api<{ relationships: RelationshipDescriptor[] }>('/network/relationships')
      .then((r) => setRels(r.relationships))
      .catch(() => setRels([]));
  }, []);

  return (
    <section>
      <h2>Supplier Portal</h2>
      <p>Active org: {me?.activeMembership?.orgId ?? '(none)'}</p>
      <h3>Buyer customers</h3>
      <ul>
        {rels.length === 0 && <li>(no buyer relationships yet)</li>}
        {rels.map((r) => (
          <li key={r.id}>
            <strong>{r.status}</strong> with buyer {r.buyerOrgId} — enabled:{' '}
            {r.enabledDocumentTypes.join(', ')}
          </li>
        ))}
      </ul>
      <p style={{ color: '#666', fontSize: 14 }}>
        Inbox of incoming POs, ASN creation, invoice PO-flip, etc. land per-document-type in Phase
        2.
      </p>
    </section>
  );
}
