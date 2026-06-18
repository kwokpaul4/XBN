import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.ts';
import { useMe } from '../auth-state.ts';

interface RelationshipDescriptor {
  id: string;
  buyerOrgId: string;
  supplierOrgId: string;
  status: string;
  enabledDocumentTypes: string[];
}

export function BuyerPortal(): React.ReactElement {
  const { me } = useMe();
  const [rels, setRels] = useState<RelationshipDescriptor[]>([]);

  useEffect(() => {
    api<{ relationships: RelationshipDescriptor[] }>('/network/relationships')
      .then((r) => setRels(r.relationships))
      .catch(() => setRels([]));
  }, []);

  return (
    <section>
      <h2>Buyer Portal</h2>
      <p>Active org: {me?.activeMembership?.orgId ?? '(none)'}</p>

      <nav style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
        <Link to="/buyer/po">My POs</Link>
        <Link to="/buyer/po/new">+ New PO</Link>
      </nav>

      <h3>Trading relationships</h3>
      <ul>
        {rels.length === 0 && <li>(no relationships yet)</li>}
        {rels.map((r) => (
          <li key={r.id}>
            <strong>{r.status}</strong> with{' '}
            {r.buyerOrgId === me?.activeMembership?.orgId ? 'supplier' : 'buyer'}{' '}
            {r.buyerOrgId === me?.activeMembership?.orgId ? r.supplierOrgId : r.buyerOrgId} —
            enabled: {r.enabledDocumentTypes.join(', ') || '(none)'}
          </li>
        ))}
      </ul>
      <p style={{ color: '#666', fontSize: 14 }}>
        ASN/GR/Invoice flows arrive in subsequent Phase 2 tasks.
      </p>
    </section>
  );
}
