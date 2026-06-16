/**
 * Argon2id password hashing.
 *
 * Argon2id is the OWASP-recommended default. We use the @node-rs/argon2
 * native binding for native-speed verification — JS-only argon2 is too
 * slow for an interactive login flow at the OWASP-recommended cost params.
 *
 * Cost: m=65536 KiB, t=3, p=4 — OWASP 2024 baseline. Verify time is
 * ~30–60ms on a modern laptop, which is the target window (slow enough
 * to deter brute force, fast enough that a login feels instant).
 */

import { hash, verify } from '@node-rs/argon2';

const ARGON2_OPTS = {
  memoryCost: 65_536, // 64 MiB
  timeCost: 3,
  parallelism: 4,
};

export async function hashPassword(plaintext: string): Promise<string> {
  if (plaintext.length < 8) {
    throw new Error('hashPassword: password must be at least 8 characters');
  }
  return hash(plaintext, ARGON2_OPTS);
}

export async function verifyPassword(plaintext: string, hashStr: string): Promise<boolean> {
  try {
    return await verify(hashStr, plaintext);
  } catch {
    // Malformed hash, etc. — never throw on a wrong password (timing-safe behaviour).
    return false;
  }
}
