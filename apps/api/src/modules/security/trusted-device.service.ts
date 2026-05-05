import { createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../common/prisma/prisma.service';
import { type AppConfig } from '../../config/configuration';

const PLATFORM_TENANT = '00000000-0000-0000-0000-000000000000';

export interface IssueDeviceInput {
  tenantId: string;
  userId: string;
  ip: string | null;
  userAgent: string | null;
}

@Injectable()
export class TrustedDeviceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  // Returns the raw token (set in cookie) — only ever leaves the server
  // here. The DB stores only sha256(token).
  async issue(input: IssueDeviceInput): Promise<{ rawToken: string; expiresAt: Date }> {
    const ttlDays = this.config.get('TRUSTED_DEVICE_TTL_DAYS', { infer: true });
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
    const rawToken = generateDeviceToken();
    const tokenHash = hashToken(rawToken);
    const uaFingerprint = input.userAgent ? hashToken(input.userAgent) : null;
    await this.prisma.runInTenantContext(input.tenantId, 'tenant', (tx) =>
      tx.trustedDevice.create({
        data: {
          tenantId: input.tenantId,
          userId: input.userId,
          tokenHash,
          uaFingerprint,
          expiresAt,
          ipAddress: input.ip,
          userAgent: input.userAgent,
        },
      }),
    );
    return { rawToken, expiresAt };
  }

  // Validate a raw token presented in the request cookie. Returns the
  // userId + tenantId if the device is trusted (and bumps lastUsedAt).
  // Returns null otherwise — caller should fall back to the MFA challenge.
  async resolve(
    rawToken: string,
    expectedUserId: string | null,
    userAgent: string | null,
  ): Promise<{ userId: string; tenantId: string; deviceId: string } | null> {
    if (!rawToken) return null;
    const tokenHash = hashToken(rawToken);
    return this.prisma.runInTenantContext(
      PLATFORM_TENANT,
      'platform_admin',
      async (tx) => {
        const row = await tx.trustedDevice.findUnique({ where: { tokenHash } });
        if (!row) return null;
        if (row.revokedAt) return null;
        if (row.expiresAt.getTime() < Date.now()) return null;
        if (expectedUserId && row.userId !== expectedUserId) return null;
        if (row.uaFingerprint && userAgent && row.uaFingerprint !== hashToken(userAgent)) {
          return null;
        }
        await tx.trustedDevice.update({
          where: { id: row.id },
          data: { lastUsedAt: new Date() },
        });
        return { userId: row.userId, tenantId: row.tenantId, deviceId: row.id };
      },
    );
  }

  async list(
    tenantId: string,
    userId: string,
    currentDeviceId: string | null,
  ): Promise<
    Array<{
      id: string;
      createdAt: Date;
      lastUsedAt: Date | null;
      expiresAt: Date;
      ipAddress: string | null;
      userAgent: string | null;
      isCurrent: boolean;
    }>
  > {
    const rows = await this.prisma.runInTenantContext(tenantId, 'tenant', (tx) =>
      tx.trustedDevice.findMany({
        where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      }),
    );
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      expiresAt: r.expiresAt,
      ipAddress: r.ipAddress,
      userAgent: r.userAgent,
      isCurrent: currentDeviceId !== null && r.id === currentDeviceId,
    }));
  }

  async revoke(tenantId: string, userId: string, deviceId: string): Promise<void> {
    await this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      await tx.trustedDevice.updateMany({
        where: { id: deviceId, userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  }
}

function generateDeviceToken(): string {
  return randomBytes(32).toString('base64url');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
