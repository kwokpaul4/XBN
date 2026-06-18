/**
 * Tiny API client. fetch wrapper that:
 *   - includes credentials so the session cookie flows
 *   - adds the x-active-org header from localStorage
 *   - throws on non-2xx with the JSON body
 */

const ACTIVE_ORG_KEY = 'xbn:activeOrgId';

export function getActiveOrgId(): string | null {
  return localStorage.getItem(ACTIVE_ORG_KEY);
}

export function setActiveOrgId(orgId: string | null): void {
  if (orgId) localStorage.setItem(ACTIVE_ORG_KEY, orgId);
  else localStorage.removeItem(ACTIVE_ORG_KEY);
}

export interface ApiError {
  status: number;
  body: unknown;
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type') && init.body) {
    headers.set('content-type', 'application/json');
  }
  const orgId = getActiveOrgId();
  if (orgId) headers.set('x-active-org', orgId);

  const res = await fetch(path, { ...init, headers, credentials: 'include' });
  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err: ApiError = { status: res.status, body };
    throw err;
  }
  return body as T;
}
