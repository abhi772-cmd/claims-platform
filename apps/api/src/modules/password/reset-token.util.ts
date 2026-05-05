import { createHash, randomBytes } from 'node:crypto';

// Same shape as the invite token — opaque 256-bit value, sha256 at rest.
// Lives in its own file so we can cycle the format independently of
// invitation if we ever need to (e.g. shorter expiry, different length).
export function generateResetToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashResetToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}
