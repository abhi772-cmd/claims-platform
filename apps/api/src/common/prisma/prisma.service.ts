import { Injectable, type OnModuleDestroy, type OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';

import { type AppConfig } from '../../config/configuration.js';
import { type TenantPrisma } from '../../types/express.js';

export type TenantRole = 'tenant' | 'platform_admin';

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
  async runInTenantContext<T>(
    tenantId: string,
    role: TenantRole,
    cb: (tx: TenantPrisma) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      // set_config(name, value, is_local=true) is transaction-local, equivalent
      // to SET LOCAL but accepts bound parameters. This is the secure pattern.
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('app.role', ${role}, true)`,
      );
      return cb(tx as unknown as TenantPrisma);
    });
  }
}
