import { useEffect, useState } from 'react';
import { api, getActiveOrgId, setActiveOrgId } from './api.ts';

export interface MembershipDescriptor {
  id: string;
  userId: string;
  orgId: string;
  role: 'BUYER_USER' | 'BUYER_ADMIN' | 'SUPPLIER_USER' | 'SUPPLIER_ADMIN' | 'NETWORK_ADMIN';
}

export interface MeResponse {
  user: { id: string; email: string; displayName: string | null };
  memberships: MembershipDescriptor[];
  activeMembership: MembershipDescriptor | null;
}

/** Returns the current user, their memberships, and the active membership.
 *  null while loading; { user: null } when unauthenticated. */
export function useMe(): { me: MeResponse | null; loading: boolean; refresh: () => void } {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<MeResponse>('/me')
      .then((data) => {
        if (cancelled) return;
        // If activeMembership is null but the user has memberships, default
        // to the first one and persist it so subsequent requests carry it.
        if (!data.activeMembership && data.memberships.length > 0) {
          setActiveOrgId(data.memberships[0]?.orgId ?? null);
        }
        setMe(data);
      })
      .catch(() => {
        if (cancelled) return;
        setMe(null);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { me, loading, refresh: () => setTick((t) => t + 1) };
}

export function switchOrg(orgId: string): void {
  setActiveOrgId(orgId);
  // Force a hard reload so any in-flight queries pick up the new header.
  window.location.reload();
}

export function activeRole(me: MeResponse | null): MembershipDescriptor['role'] | null {
  if (!me) return null;
  const orgId = getActiveOrgId();
  const m = orgId ? me.memberships.find((mm) => mm.orgId === orgId) : me.memberships[0];
  return m?.role ?? null;
}
