import { randomBytes } from 'node:crypto';

// Opaque challenge id — handed to the client between /auth/login and
// /auth/mfa/verify. Pure entropy (no claims), so we don't need to hash it
// at rest; the row itself is short-lived and tenant-scoped via RLS.
export function generateChallengeId(): string {
  return randomBytes(32).toString('base64url');
}
