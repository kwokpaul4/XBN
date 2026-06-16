/**
 * Body-schema registry (PHASES.md §1.5, CLAUDE.md cross-cutting concern #1).
 *
 * Each document type's canonical body shape is registered here as a Zod
 * schema. Used at:
 *   - publish time     → validate that the body matches the type's contract
 *   - read time        → typed access in callers (`registry.parse('PO', body)`)
 *   - documentation    → Phase 5.4 catalog generation
 *
 * Adding a document type means: define a Zod schema, register it, done.
 * No conditional code per type — this is the registry's whole point.
 *
 * Zod 4 introduced safer JSON-mode parsing and better discriminated-union
 * support (used by Phase 2.6 INVOICE which has invoice_mode ∈ {PO_FLIP, SUMMARY}).
 */

import type { ZodTypeAny, infer as ZodInfer } from 'zod';

export type BodySchemaParseResult<T> =
  | { readonly ok: true; readonly body: T }
  | { readonly ok: false; readonly reason: BodySchemaRejection };

export type BodySchemaRejection =
  | { readonly kind: 'unknown_document_type'; readonly documentType: string }
  | { readonly kind: 'validation_failed'; readonly issues: ReadonlyArray<BodyIssue> };

export interface BodyIssue {
  // Zod 4 uses PropertyKey here. In practice paths into JSON bodies are always
  // string|number (symbols can't be JSON keys), but the type system can't see
  // that — so we mirror Zod's shape rather than narrow it and force casts.
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
}

export class BodySchemaRegistry {
  private readonly schemas = new Map<string, ZodTypeAny>();

  /**
   * Register a Zod schema for a document type. Re-registering throws —
   * registries are loaded once at app boot.
   */
  register(documentType: string, schema: ZodTypeAny): void {
    if (this.schemas.has(documentType)) {
      throw new Error(`BodySchemaRegistry: duplicate schema for "${documentType}"`);
    }
    this.schemas.set(documentType, schema);
  }

  /**
   * Validate and return a strongly-typed body. Returns a result rather than
   * throwing so the caller can decide whether to log, audit, or surface to UI.
   */
  parse<S extends ZodTypeAny>(
    documentType: string,
    body: unknown,
  ): BodySchemaParseResult<ZodInfer<S>> {
    const schema = this.schemas.get(documentType);
    if (!schema) {
      return { ok: false, reason: { kind: 'unknown_document_type', documentType } };
    }
    const parsed = schema.safeParse(body);
    if (parsed.success) {
      return { ok: true, body: parsed.data as ZodInfer<S> };
    }
    const issues: BodyIssue[] = parsed.error.issues.map((i) => ({
      path: i.path,
      message: i.message,
    }));
    return { ok: false, reason: { kind: 'validation_failed', issues } };
  }

  /**
   * True if a schema is registered for this document type.
   */
  has(documentType: string): boolean {
    return this.schemas.has(documentType);
  }

  /**
   * All registered document types. Phase 5.4 doc generator iterates over this.
   */
  registeredTypes(): ReadonlyArray<string> {
    return Array.from(this.schemas.keys()).sort();
  }
}
