import { Injectable, type OnModuleDestroy, type OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';

import { type AppConfig } from '../../config/configuration';
import { type TenantPrisma } from '../../types/express';

// 'retention_sweeper' (Slice BP) is a privileged role used only by
// the audit retention sweep — it's the only role allowed to DELETE
// from audit_log, gated by the audit_log_delete_retention RLS policy.
export type TenantRole = 'tenant' | 'platform_admin' | 'retention_sweeper';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(PrismaService.name);

  constructor(config: ConfigService<AppConfig, true>) {
    super({
      datasources: { db: { url: config.get('DATABASE_URL', { infer: true }) } },
      log: ['warn', 'error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.log.log('Prisma connected (claims_app role).');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  // Opens a transaction and sets the tenant GUC + role GUC parameterised
  // (NEVER use $executeRawUnsafe with template-string interpolation here).
  // RLS policies on tenant-scoped tables read these GUCs to enforce isolation.
  // Returns whatever the callback returns.
  //
  // Timeout is bumped above Prisma's 5s default because (a) some
  // tenant-scoped flows do 5-7 serial round-trips inside the tx
  // (login, claim submit, settlement upload), and (b) we observed
  // cross-region Neon round-trips pushing those flows past 5s
  // intermittently — the tx then aborts with "Transaction already
  // closed" mid-flow. 30s gives comfortable headroom for any tenant
  // operation we'd reasonably wrap in one tx; anything genuinely
  // slower than that should not be in a tenant tx at all.
  // maxWait is also bumped because high-latency links can stall the
  // initial connection acquisition past the 2s default.
  async runInTenantContext<T>(
    tenantId: string,
    role: TenantRole,
    cb: (tx: TenantPrisma) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(
      async (tx) => {
        // set_config(name, value, is_local=true) is transaction-local, equivalent
        // to SET LOCAL but accepts bound parameters. This is the secure pattern.
        await tx.$executeRaw(
          Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('app.role', ${role}, true)`,
        );
        return cb(tx as unknown as TenantPrisma);
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
  }
}
