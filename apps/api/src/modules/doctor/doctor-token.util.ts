import { createHash, randomBytes } from 'node:crypto';

// Same shape as invite/reset tokens — opaque, sha256 at rest. Lives in
// its own file because doctor-tokens have a much shorter TTL (10 min)
// and may grow side-channel features (e.g. SMS OTP confirmation) that
// invite tokens don't need.
export function generateDoctorToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashDoctorToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}
