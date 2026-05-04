import { createHash, randomBytes } from 'node:crypto';

// Opaque invite tokens: 256 bits of randomness, base64url-encoded for URL
// safety, and SHA-256-hashed at rest. Only the raw token ever leaves the
// server (via email/SMS link); the DB stores the hash.
export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashInviteToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}
