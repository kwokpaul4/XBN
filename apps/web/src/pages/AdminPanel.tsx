import { useEffect, useState } from 'react';
import { api, type ApiError } from '../api.ts';
import { useMe } from '../auth-state.ts';

interface OrgDescriptor {
  id: string;
  legalName: string;
  displayName: string;
  orgType: string;
}

export function AdminPanel(): React.ReactElement {
  const { me, refresh } = useMe();
  const [orgs, setOrgs] = useState<OrgDescriptor[]>([]);
  const [legalName, setLegalName] = useState('');
  const [orgType, setOrgType] = useState<'BUYER' | 'SUPPLIER'>('BUYER');
  const [err, setErr] = useState<string | null>(null);

  const reloadOrgs = (): void => {
    api<{ orgs: OrgDescriptor[] }>('/network/orgs')
      .then((r) => setOrgs(r.orgs))
      .catch(() => setOrgs([]));
  };

  useEffect(() => {
    reloadOrgs();
  }, []);

  const createOrg = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setErr(null);
    try {
      await api('/network/orgs', {
        method: 'POST',
        body: JSON.stringify({
          legalName,
          displayName: legalName,
          orgType,
          bindAsRole: orgType === 'BUYER' ? 'BUYER_ADMIN' : 'SUPPLIER_ADMIN',
        }),
      });
      setLegalName('');
      reloadOrgs();
      refresh();
    } catch (caught) {
      const apiErr = caught as ApiError;
      setErr(JSON.stringify(apiErr.body));
    }
  };

  return (
    <section>
      <h2>Admin Panel</h2>
      <p>You can create your own org and become its admin.</p>
      <form
        onSubmit={createOrg}
        style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 24 }}
      >
        <input
          placeholder="Legal name"
          value={legalName}
          onChange={(e) => setLegalName(e.target.value)}
          required
        />
        <select
          value={orgType}
          onChange={(e) => setOrgType(e.target.value as 'BUYER' | 'SUPPLIER')}
        >
          <option value="BUYER">Buyer</option>
          <option value="SUPPLIER">Supplier</option>
        </select>
        <button type="submit">Create org</button>
        {err && <span style={{ color: 'red' }}>{err}</span>}
      </form>
      <h3>All orgs on the network</h3>
      <ul>
        {orgs.map((o) => (
          <li key={o.id}>
            {o.displayName} ({o.orgType}) — id: <code>{o.id}</code>
          </li>
        ))}
      </ul>
      <h3>You are a member of</h3>
      <ul>
        {(me?.memberships ?? []).map((m) => (
          <li key={m.id}>
            {m.role} in org <code>{m.orgId}</code>
          </li>
        ))}
      </ul>
    </section>
  );
}
