import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../common/prisma/prisma.service';
import { type AppConfig } from '../../config/configuration';
import { type TenantPrisma } from '../../types/express';
import { AuditEvents, AuditService } from '../audit';

export interface SessionListItem {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  isCurrent: boolean;
}

@Injectable()
export class SessionService {
  private readonly log = new Logger(SessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly audit: AuditService,
  ) {}

  // Enforce per-user concurrent-session cap. Called inside the same tx
  // that creates the new session, BEFORE the create — we evict the
  // oldest until the count is below the cap, leaving room for the
  // incoming session. The caller MUST hand us a tx running in
  // platform_admin context — session_token_history's RLS only allows
  // platform_admin inserts. (finalizeLogin already does this.)
  //
  // Eviction is FIFO by createdAt. Each evicted session gets a
  // SESSION_REVOKED audit row + the refreshTokenHash logged into
  // session_token_history (so reuse of the dropped token is detected
  // as reuse rather than just "unknown token").
  async enforceCapBeforeCreate(
    tx: TenantPrisma,
    tenantId: string,
    userId: string,
  ): Promise<void> {
    const cap = this.config.get('CONCURRENT_SESSION_LIMIT', { infer: true });
    const active = await tx.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'asc' },
    });
    if (active.length < cap) return;
    // Evict (active.length - cap + 1) oldest so the imminent new session
    // brings us to exactly cap.
    const toEvictCount = active.length - cap + 1;
    const evict = active.slice(0, toEvictCount);
    for (const s of evict) {
      await tx.sessionTokenHistory.create({
        data: {
          sessionId: s.id,
          userId: s.userId,
          refreshTokenHash: s.refreshTokenHash,
          rotatedAt: new Date(),
        },
      });
      await tx.session.delete({ where: { id: s.id } });
      await this.audit.recordWithTx(tx, {
        tenantId,
        actorUserId: userId,
        actorType: 'user',
        action: AuditEvents.SESSION_REVOKED,
        resourceType: 'session',
        resourceId: s.id,
        after: { reason: 'concurrent_session_limit', cap },
      });
    }
    if (evict.length > 0) {
      this.log.log(`evicted ${evict.length} session(s) userId=${userId} cap=${cap}`);
    }
  }

  async list(
    tenantId: string,
    userId: string,
    currentSessionId: string,
  ): Promise<SessionListItem[]> {
    const rows = await this.prisma.runInTenantContext(tenantId, 'tenant', (tx) =>
      tx.session.findMany({
        where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      }),
    );
    return rows.map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      ipAddress: s.ipAddress,
      userAgent: s.userAgent,
      isCurrent: s.id === currentSessionId,
    }));
  }

  // Revoke a specific session for the user. Refuses to revoke the
  // current session (call /auth/logout for that). Returns true if a
  // session was revoked.
  //
  // Runs in platform_admin context because session_token_history's RLS
  // only allows platform_admin inserts (it's an internal reuse-detection
  // ledger, not a tenant-facing table).
  async revoke(
    tenantId: string,
    userId: string,
    sessionId: string,
    currentSessionId: string,
    actorIp: string | null,
    actorUserAgent: string | null,
  ): Promise<boolean> {
    if (sessionId === currentSessionId) return false;
    return this.prisma.runInTenantContext(
      '00000000-0000-0000-0000-000000000000',
      'platform_admin',
      async (tx) => {
        const target = await tx.session.findUnique({ where: { id: sessionId } });
        if (!target || target.userId !== userId || target.tenantId !== tenantId) {
          return false;
        }
        await tx.sessionTokenHistory.create({
          data: {
            sessionId: target.id,
            userId: target.userId,
            refreshTokenHash: target.refreshTokenHash,
            rotatedAt: new Date(),
          },
        });
        await tx.session.delete({ where: { id: target.id } });
        await this.audit.recordWithTx(tx, {
          tenantId,
          actorUserId: userId,
          actorType: 'user',
          action: AuditEvents.SESSION_REVOKED,
          resourceType: 'session',
          resourceId: target.id,
          after: { reason: 'self_service_revoke' },
          ipAddress: actorIp,
          userAgent: actorUserAgent,
        });
        return true;
      },
    );
  }
}
