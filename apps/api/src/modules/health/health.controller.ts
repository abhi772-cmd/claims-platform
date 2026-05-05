import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../common/prisma/prisma.service';
import { type AppConfig } from '../../config/configuration';

interface ReadinessChecks {
  database: boolean;
  // True when no _prisma_migrations rows are unfinished. False if a
  // migration is mid-flight or rolled back; null on probe failure.
  migrations: boolean | null;
}

interface ReadinessResponse {
  status: 'ok' | 'degraded';
  checks: ReadinessChecks;
  // Adapter modes — handy for ops dashboards to confirm what's wired
  // without round-tripping to env.
  adapters: {
    nhcx: 'stub' | 'real';
    hpr: 'stub' | 'real';
    storage: 'stub' | 'real';
  };
  // Build provenance, mirrors /health/version. Helpful when the
  // readiness endpoint is the only thing your load balancer can hit.
  build: {
    commit: string;
    builtAt: string;
  };
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<ReadinessResponse> {
    const dbOk = await this.pingDb();
    const migrationsOk = dbOk ? await this.checkMigrations() : null;
    const allOk = dbOk && migrationsOk === true;
    return {
      status: allOk ? 'ok' : 'degraded',
      checks: { database: dbOk, migrations: migrationsOk },
      adapters: {
        nhcx: this.config.get('NHCX_MODE', { infer: true }),
        hpr: this.config.get('HPR_MODE', { infer: true }),
        storage: this.config.get('STORAGE_MODE', { infer: true }),
      },
      build: {
        commit: process.env['GIT_SHA'] ?? 'dev',
        builtAt: process.env['BUILT_AT'] ?? new Date(0).toISOString(),
      },
    };
  }

  @Get('version')
  version(): { name: string; commit: string; builtAt: string } {
    return {
      name: '@claims/api',
      commit: process.env['GIT_SHA'] ?? 'dev',
      builtAt: process.env['BUILT_AT'] ?? new Date(0).toISOString(),
    };
  }

  private async pingDb(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  // Inspect prisma's _prisma_migrations bookkeeping. Each migration
  // row has finished_at + rolled_back_at; we want every applied
  // migration to be finished and not rolled back. A degraded migration
  // state (mid-application or rolled back) means the schema doesn't
  // match what the code expects — pull the instance out of rotation.
  private async checkMigrations(): Promise<boolean> {
    try {
      const rows = await this.prisma.$queryRaw<
        Array<{ unfinished: bigint; rolled_back: bigint; total: bigint }>
      >`
        SELECT
          COUNT(*) FILTER (WHERE finished_at IS NULL) AS unfinished,
          COUNT(*) FILTER (WHERE rolled_back_at IS NOT NULL) AS rolled_back,
          COUNT(*) AS total
        FROM _prisma_migrations
      `;
      const row = rows[0];
      if (!row) return false;
      const total = Number(row.total);
      const unfinished = Number(row.unfinished);
      const rolledBack = Number(row.rolled_back);
      return total > 0 && unfinished === 0 && rolledBack === 0;
    } catch {
      return false;
    }
  }
}
