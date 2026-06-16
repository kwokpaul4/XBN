import { describe, expect, it } from 'vitest';
import { ExternalNumberingStrategy, InMemoryNetworkNumberingStrategy } from './numbering.js';

describe('InMemoryNetworkNumberingStrategy', () => {
  it('returns sequential numbers per (issuerOrgId, documentType)', async () => {
    const strategy = new InMemoryNetworkNumberingStrategy();
    const a1 = await strategy.next({ issuerOrgId: 'org_a', documentType: 'PO' });
    const a2 = await strategy.next({ issuerOrgId: 'org_a', documentType: 'PO' });
    const a3 = await strategy.next({ issuerOrgId: 'org_a', documentType: 'PO' });
    expect(a1).toBe('PO-000001');
    expect(a2).toBe('PO-000002');
    expect(a3).toBe('PO-000003');
  });

  it('isolates counters across orgs', async () => {
    const strategy = new InMemoryNetworkNumberingStrategy();
    const a1 = await strategy.next({ issuerOrgId: 'org_a', documentType: 'PO' });
    const b1 = await strategy.next({ issuerOrgId: 'org_b', documentType: 'PO' });
    expect(a1).toBe('PO-000001');
    expect(b1).toBe('PO-000001');
  });

  it('isolates counters across document types', async () => {
    const strategy = new InMemoryNetworkNumberingStrategy();
    const po = await strategy.next({ issuerOrgId: 'org_a', documentType: 'PO' });
    const asn = await strategy.next({ issuerOrgId: 'org_a', documentType: 'ASN' });
    expect(po).toBe('PO-000001');
    expect(asn).toBe('ASN-000001');
  });

  it('honours per-call prefix override', async () => {
    const strategy = new InMemoryNetworkNumberingStrategy();
    const result = await strategy.next({
      issuerOrgId: 'org_a',
      documentType: 'PO',
      prefix: 'BUY-2026',
    });
    expect(result).toBe('BUY-2026-000001');
  });

  it('reset() clears the counters', async () => {
    const strategy = new InMemoryNetworkNumberingStrategy();
    await strategy.next({ issuerOrgId: 'org_a', documentType: 'PO' });
    await strategy.next({ issuerOrgId: 'org_a', documentType: 'PO' });
    strategy.reset();
    const fresh = await strategy.next({ issuerOrgId: 'org_a', documentType: 'PO' });
    expect(fresh).toBe('PO-000001');
  });
});

describe('ExternalNumberingStrategy', () => {
  it('returns the externalNumber verbatim', async () => {
    const strategy = new ExternalNumberingStrategy();
    const result = await strategy.next({
      issuerOrgId: 'org_a',
      documentType: 'PO',
      externalNumber: 'ERP-PO-9X7',
    });
    expect(result).toBe('ERP-PO-9X7');
  });

  it('throws if externalNumber is missing', async () => {
    const strategy = new ExternalNumberingStrategy();
    await expect(strategy.next({ issuerOrgId: 'org_a', documentType: 'PO' })).rejects.toThrow(
      /externalNumber is required/,
    );
  });

  it('throws on whitespace-only externalNumber', async () => {
    const strategy = new ExternalNumberingStrategy();
    await expect(
      strategy.next({
        issuerOrgId: 'org_a',
        documentType: 'PO',
        externalNumber: '   ',
      }),
    ).rejects.toThrow(/externalNumber is required/);
  });
});
