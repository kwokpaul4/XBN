// Reusable document substrate (PHASES.md §1.5).
//
// This package is intentionally empty at Phase 1.1 — only the workspace shell exists.
// Phase 1.5 lands:
//   - documents / document_versions / document_links / document_audit_log / attachments tables (via @xbn/db)
//   - state-machine factory
//   - five universal operations (publish / acknowledge / supersede / cancel / link)
//   - document numbering (pluggable: network vs external)
//   - link-type registry
//   - trading-relationship guard
//   - body-schema (Zod) registry
//   - notification emitter
//   - attachment storage abstraction

export const placeholder = 'xbn-document-core';
