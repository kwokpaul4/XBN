import { describe, expect, it } from 'vitest';
import { LinkRegistry } from './link-registry.js';

describe('LinkRegistry', () => {
  it('registers and looks up a rule', () => {
    const reg = new LinkRegistry();
    reg.register({
      fromType: 'ORDER_CONFIRMATION',
      toType: 'PO',
      linkType: 'ACKNOWLEDGES',
      inboundCardinality: 'one',
      outboundCardinality: 'one',
    });

    const result = reg.lookup('ORDER_CONFIRMATION', 'PO', 'ACKNOWLEDGES');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rule.inboundCardinality).toBe('one');
      expect(result.rule.outboundCardinality).toBe('one');
    }
  });

  it('rejects unknown link with descriptive reason', () => {
    const reg = new LinkRegistry();
    const result = reg.lookup('ASN', 'PO', 'INVOICES');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.kind).toBe('unknown_link');
      if (result.reason.kind === 'unknown_link') {
        expect(result.reason.fromType).toBe('ASN');
        expect(result.reason.linkType).toBe('INVOICES');
      }
    }
  });

  it('rejects duplicate registration', () => {
    const reg = new LinkRegistry();
    reg.register({
      fromType: 'INVOICE',
      toType: 'PO',
      linkType: 'INVOICES',
      inboundCardinality: 'one',
      outboundCardinality: 'one',
    });
    expect(() =>
      reg.register({
        fromType: 'INVOICE',
        toType: 'PO',
        linkType: 'INVOICES',
        inboundCardinality: 'many',
        outboundCardinality: 'many',
      }),
    ).toThrow(/duplicate rule/);
  });

  it('treats different linkTypes between the same pair as distinct rules', () => {
    const reg = new LinkRegistry();
    reg.register({
      fromType: 'ASN',
      toType: 'PO',
      linkType: 'SHIPS_AGAINST',
      inboundCardinality: 'many',
      outboundCardinality: 'one',
    });
    reg.register({
      fromType: 'ASN',
      toType: 'PO',
      linkType: 'CANCELS_OF',
      inboundCardinality: 'one',
      outboundCardinality: 'one',
    });
    expect(reg.size()).toBe(2);
  });

  it('outboundFrom and inboundTo return matching rules', () => {
    const reg = new LinkRegistry();
    reg.register({
      fromType: 'INVOICE',
      toType: 'PO',
      linkType: 'INVOICES',
      inboundCardinality: 'many', // SUMMARY mode: a PO may be invoiced once per period across many summary invoices
      outboundCardinality: 'many',
    });
    reg.register({
      fromType: 'INVOICE',
      toType: 'GOODS_RECEIPT',
      linkType: 'INVOICES',
      inboundCardinality: 'many',
      outboundCardinality: 'many',
    });
    reg.register({
      fromType: 'CREDIT_MEMO',
      toType: 'INVOICE',
      linkType: 'CREDITS',
      inboundCardinality: 'many',
      outboundCardinality: 'one',
    });

    expect(reg.outboundFrom('INVOICE')).toHaveLength(2);
    expect(reg.outboundFrom('CREDIT_MEMO')).toHaveLength(1);
    expect(reg.inboundTo('INVOICE')).toHaveLength(1);
    expect(reg.inboundTo('PO')).toHaveLength(1);
  });

  it('cardinality captures summary-invoice semantics (PHASES.md §2.6)', () => {
    // SUMMARY invoice: outbound 'many' means one invoice can INVOICES → many POs.
    // Inbound 'many' means a PO can be referenced by exactly one invoice across
    // its lifetime (the link-uniqueness DB index enforces no double-billing —
    // see schema.prisma DocumentLink @@unique).
    const reg = new LinkRegistry();
    reg.register({
      fromType: 'INVOICE',
      toType: 'PO',
      linkType: 'INVOICES',
      inboundCardinality: 'many',
      outboundCardinality: 'many',
    });
    const result = reg.lookup('INVOICE', 'PO', 'INVOICES');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rule.outboundCardinality).toBe('many');
      expect(result.rule.inboundCardinality).toBe('many');
    }
  });
});
