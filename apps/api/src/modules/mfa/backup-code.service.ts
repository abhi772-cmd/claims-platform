import { createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';

const BACKUP_CODE_COUNT = 10;
// Crockford-base32 (omits I, L, O, U) cuts down on misreads. We use only
// the unambiguous alphabet so users typing codes off a printed sheet can't
// confuse 0 with O or 1 with I/L.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

@Injectable()
export class BackupCodeService {
  // Generate a fresh batch (10) of XXXX-XXXX-XXXX-formatted codes. Returns
  // both the raw codes (returned to the user once) and the hashes (stored
  // in the DB).
  generateBatch(): { raw: string[]; hashes: string[] } {
    const raw: string[] = [];
    const hashes: string[] = [];
    while (raw.length < BACKUP_CODE_COUNT) {
      const code = generateCode();
      // Skip the (extremely unlikely) duplicate within this batch.
      if (raw.includes(code)) continue;
      raw.push(code);
      hashes.push(this.hash(code));
    }
    return { raw, hashes };
  }

  // Hash applied at storage. Backup codes have far less entropy than refresh
  // tokens (12 chars × 5 bits = 60 bits) but enough that a pre-image search
  // is intractable at sha256. We don't argon2 these — they're throwaway and
  // verified at login latency, so sha256 keeps the constant-time hot path
  // light.
  hash(code: string): string {
    return createHash('sha256').update(this.normalise(code)).digest('hex');
  }

  // Accept loose input from the user (lowercase, missing dashes) and
  // canonicalise it so the hash matches the stored value.
  normalise(code: string): string {
    return code.toUpperCase().replace(/[^0-9A-Z]/g, '');
  }

  // Returns true if the input looks like a backup code (after normalisation)
  // — used by /auth/mfa/verify to dispatch between the TOTP and backup-code
  // paths without needing two different endpoints.
  looksLikeBackupCode(input: string): boolean {
    const normal = this.normalise(input);
    return normal.length === 12 && /^[0-9A-HJ-NP-TV-Z]+$/.test(normal);
  }
}

function generateCode(): string {
  const buf = randomBytes(12);
  const chars: string[] = [];
  for (let i = 0; i < 12; i++) {
    chars.push(ALPHABET[buf[i]! % ALPHABET.length]!);
  }
  // Format as XXXX-XXXX-XXXX for legibility.
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}`;
}
