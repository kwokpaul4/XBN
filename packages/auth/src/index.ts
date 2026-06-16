/**
 * @xbn/auth — identity, authentication, and authorization primitives.
 *
 * Phase 1.2 (PHASES.md §1.2):
 *   - User registration with Argon2id password hashing
 *   - Login → opaque session token (random 32 bytes, hashed at rest)
 *   - Password reset and email-verification token flows
 *   - Multi-org membership: a user may belong to multiple Orgs with a
 *     distinct OrgRole per (user, org)
 *   - Authorization helpers: assertRole(membership, requiredRoles[])
 *
 * Sessions follow the "stateless cookie + DB session row" pattern (also
 * called the "Lucia-style" approach since Lucia v3 was deprecated in 2024).
 * The cookie holds a random 32-byte token; the DB stores SHA-256(token)
 * keyed by an opaque session id. This means a leaked DB session row does
 * NOT yield a valid cookie value, and a leaked cookie is invalid until it
 * lookups a row.
 *
 * Phase 4.5 will wire email delivery (verification, reset). Until then the
 * tokens are returned to the caller and exposed in test assertions.
 */

export * from './password.js';
export * from './sessions.js';
export * from './tokens.js';
export * from './users.js';
export * from './memberships.js';
export * from './guards.js';
