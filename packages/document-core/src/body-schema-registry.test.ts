import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BodySchemaRegistry } from './body-schema-registry.js';

describe('BodySchemaRegistry', () => {
  it('registers and parses a valid body', () => {
    const reg = new BodySchemaRegistry();
    const poSchema = z.object({
      currency: z.string().length(3),
      lines: z.array(
        z.object({
          sku: z.string(),
          quantity: z.number().positive(),
          unitPrice: z.number().nonnegative(),
        }),
      ),
    });
    reg.register('PO', poSchema);

    const result = reg.parse<typeof poSchema>('PO', {
      currency: 'USD',
      lines: [{ sku: 'WIDGET-1', quantity: 5, unitPrice: 12.5 }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.currency).toBe('USD');
      expect(result.body.lines[0]?.sku).toBe('WIDGET-1');
    }
  });

  it('returns validation issues for an invalid body', () => {
    const reg = new BodySchemaRegistry();
    reg.register(
      'PO',
      z.object({
        currency: z.string().length(3),
        lines: z.array(z.object({ sku: z.string(), quantity: z.number().positive() })),
      }),
    );

    const result = reg.parse('PO', {
      currency: 'US', // wrong length
      lines: [{ sku: 'X', quantity: -1 }], // negative quantity
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.reason.kind === 'validation_failed') {
      expect(result.reason.issues.length).toBeGreaterThan(0);
      // Issues report a path so the UI can highlight the right field.
      expect(result.reason.issues.some((i) => i.path.includes('currency'))).toBe(true);
    }
  });

  it('rejects parse for an unregistered document type', () => {
    const reg = new BodySchemaRegistry();
    const result = reg.parse('NOT_A_REAL_TYPE', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.kind).toBe('unknown_document_type');
    }
  });

  it('throws on duplicate registration', () => {
    const reg = new BodySchemaRegistry();
    reg.register('PO', z.object({}));
    expect(() => reg.register('PO', z.object({}))).toThrow(/duplicate schema/);
  });

  it('has() and registeredTypes() report registry state', () => {
    const reg = new BodySchemaRegistry();
    reg.register('PO', z.object({}));
    reg.register('ASN', z.object({}));
    expect(reg.has('PO')).toBe(true);
    expect(reg.has('NOPE')).toBe(false);
    expect(reg.registeredTypes()).toEqual(['ASN', 'PO']);
  });

  // PHASES.md §2.6: INVOICE has invoice_mode ∈ {PO_FLIP, SUMMARY} — this
  // discriminated-union pattern is what Phase 2 will hit. Validate the
  // registry handles it cleanly.
  it('handles a discriminated-union body (PO_FLIP vs SUMMARY invoice)', () => {
    const reg = new BodySchemaRegistry();
    const invoiceSchema = z.discriminatedUnion('invoice_mode', [
      z.object({
        invoice_mode: z.literal('PO_FLIP'),
        po_id: z.string(),
        lines: z.array(z.object({ amount: z.number() })),
      }),
      z.object({
        invoice_mode: z.literal('SUMMARY'),
        billing_period_start: z.string(),
        billing_period_end: z.string(),
        lines: z.array(
          z.object({
            source_document_id: z.string(),
            amount: z.number(),
          }),
        ),
      }),
    ]);
    reg.register('INVOICE', invoiceSchema);

    const flipResult = reg.parse('INVOICE', {
      invoice_mode: 'PO_FLIP',
      po_id: 'po_123',
      lines: [{ amount: 100 }],
    });
    expect(flipResult.ok).toBe(true);

    const summaryResult = reg.parse('INVOICE', {
      invoice_mode: 'SUMMARY',
      billing_period_start: '2026-06-01',
      billing_period_end: '2026-06-30',
      lines: [{ source_document_id: 'po_1', amount: 100 }],
    });
    expect(summaryResult.ok).toBe(true);

    // Mixing keys from the wrong arm is rejected.
    const badResult = reg.parse('INVOICE', {
      invoice_mode: 'PO_FLIP',
      billing_period_start: '2026-06-01', // wrong arm
      lines: [],
    });
    expect(badResult.ok).toBe(false);
  });
});
