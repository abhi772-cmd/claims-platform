import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';

// In-process offline breach list. v1 ships a curated list of the most-common
// breached passwords (top of public corpora — extending it to the full
// HIBP top-100k is a drop-in replacement of common-passwords.txt by ops).
// Lookups go through the SHA-1 hex of the lower-cased password, which is
// the format HIBP itself uses; that lets us swap in the official list
// without rewriting the loader.
@Injectable()
export class BreachList {
  private readonly log = new Logger(BreachList.name);
  private readonly hashes: ReadonlySet<string>;

  constructor() {
    this.hashes = this.load();
  }

  // Returns true if the password appears in the breach list.
  contains(password: string): boolean {
    if (this.hashes.size === 0) return false;
    const sha1 = sha1Hex(password);
    return this.hashes.has(sha1);
  }

  size(): number {
    return this.hashes.size;
  }

  private load(): ReadonlySet<string> {
    const candidates = [
      // Production / dev: bundled list lives alongside the source file.
      join(__dirname, 'common-passwords.txt'),
      // Compiled (dist/) layout fallback.
      join(__dirname, '..', 'common-passwords.txt'),
    ];
    for (const path of candidates) {
      try {
        const raw = readFileSync(path, 'utf8');
        const out = new Set<string>();
        for (const line of raw.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          // Allow either raw passwords (we hash them) or pre-hashed lines
          // starting with "sha1:" — useful when ops swaps in the full HIBP
          // list without storing plaintext.
          if (trimmed.startsWith('sha1:')) {
            out.add(trimmed.slice('sha1:'.length).toUpperCase());
          } else {
            out.add(sha1Hex(trimmed));
          }
        }
        this.log.log(`breach list loaded entries=${out.size} from=${path}`);
        return out;
      } catch {
        // Try the next candidate path.
      }
    }
    this.log.warn('breach list file not found — breach checks disabled');
    return new Set<string>();
  }
}

function sha1Hex(input: string): string {
  return createHash('sha1').update(input).digest('hex').toUpperCase();
}
