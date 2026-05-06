import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';

// Maintains a process-local cache of the set of NHCX sender codes
// allowed to call /nhcx/inbound. Source of truth is the Payer master
// (Payer.hcxCode for active rows) — when ops add or deactivate a
// payer, the cache picks the change up at the next TTL boundary
// (~60s) or on explicit invalidate().
//
// Default-permit semantics: if the allowlist is empty (e.g., a test
// rig with no payers seeded), every sender is allowed. Production
// deployments seed at least one payer, so the allowlist becomes
// non-empty and enforcement kicks in. This avoids the chicken-and-egg
// problem of needing to seed a payer before any test can run.
const CACHE_TTL_MS = 60_000;

@Injectable()
export class NhcxSenderAllowlistService {
  private readonly log = new Logger(NhcxSenderAllowlistService.name);
  private cached: { codes: ReadonlySet<string>; expiresAt: number } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  // Returns true when the sender is allowed. Returns true for any
  // sender when the allowlist is empty (default-permit). Logs when
  // a sender is rejected so ops can see why a callback was dropped.
  async isAllowed(senderCode: string | null): Promise<boolean> {
    const allowlist = await this.load();
    if (allowlist.size === 0) return true;
    if (!senderCode) {
      this.log.warn(
        'nhcx inbound rejected — missing x-hcx-sender-code header (allowlist non-empty)',
      );
      return false;
    }
    if (!allowlist.has(senderCode)) {
      this.log.warn(
        `nhcx inbound rejected — sender code '${senderCode}' is not in the payer allowlist`,
      );
      return false;
    }
    return true;
  }

  // Test + admin-tooling hook to drop the cached entry. Called when
  // operators add / activate / deactivate a payer.
  invalidate(): void {
    this.cached = null;
  }

  private async load(): Promise<ReadonlySet<string>> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt > now) return this.cached.codes;
    // Payer is platform-level but RLS still requires app.role to be
    // 'platform_admin' or 'tenant'. We use platform_admin because the
    // inbound dispatcher hasn't resolved a tenant yet.
    const rows = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.role', 'platform_admin', true)`;
      return tx.payer.findMany({
        where: { active: true, hcxCode: { not: null } },
        select: { hcxCode: true },
      });
    });
    const codes = new Set<string>();
    for (const r of rows) {
      if (r.hcxCode) codes.add(r.hcxCode);
    }
    this.cached = { codes, expiresAt: now + CACHE_TTL_MS };
    return codes;
  }
}
