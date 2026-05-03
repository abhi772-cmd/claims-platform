import { Controller, Get } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok' | 'degraded'; checks: Record<string, boolean> }> {
    const dbOk = await this.pingDb();
    const status = dbOk ? 'ok' : 'degraded';
    return { status, checks: { database: dbOk } };
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
}
