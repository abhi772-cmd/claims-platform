import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { verify } from 'argon2';

import { PasswordPolicyService } from './password-policy.service';
import { generateResetToken, hashResetToken } from './reset-token.util';
import {
  CurrentPasswordIncorrectError,
  PasswordResetTokenExpiredError,
  PasswordResetTokenInvalidError,
  PasswordResetTokenUsedError,
} from '../../common/errors/auth-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { type AppConfig } from '../../config/configuration';
import { AuditEvents, AuditService } from '../audit';
import { NotificationService } from '../notification';

const PLATFORM_TENANT = '00000000-0000-0000-0000-000000000000';

export interface InitiateResetInput {
  email: string;
  ip: string | null;
  userAgent: string | null;
}

export interface CompleteResetInput {
  rawToken: string;
  newPassword: string;
  ip: string | null;
  userAgent: string | null;
}

export interface VerifyResetOutput {
  email: string;
  firstName: string;
  expiresAt: Date;
}

export interface ChangePasswordInput {
  tenantId: string;
  userId: string;
  currentPassword: string;
  newPassword: string;
  ip: string | null;
  userAgent: string | null;
}

@Injectable()
export class PasswordService {
  private readonly log = new Logger(PasswordService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly policy: PasswordPolicyService,
  ) {}

  // Endpoint behaviour: ALWAYS returns success to the caller. We never
  // confirm or deny that the email maps to an account, since that would
  // leak account existence. Side effects (token row + email) only happen
  // when a real user is found.
  async initiate(input: InitiateResetInput): Promise<void> {
    const ttlMin = this.config.get('PASSWORD_RESET_TOKEN_TTL_MINUTES', { infer: true });
    const dailyLimit = this.config.get('PASSWORD_RESET_RATE_LIMIT_PER_DAY', { infer: true });
    const expiresAt = new Date(Date.now() + ttlMin * 60 * 1000);
    const rawToken = generateResetToken();
    const tokenHash = hashResetToken(rawToken);

    const dispatch = await this.prisma.runInTenantContext(
      PLATFORM_TENANT,
      'platform_admin',
      async (tx) => {
        const user = await tx.user.findUnique({
          where: { email: input.email },
          select: { id: true, tenantId: true, firstName: true, status: true },
        });
        if (!user || user.status !== 'active') return null;

        // Daily rate limit per user — the lookup is by userId so we silently
        // drop further requests once the cap is hit. We still resolve a 204
        // to the caller so the response shape doesn't leak the limit.
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const recent = await tx.passwordResetToken.count({
          where: { userId: user.id, requestedAt: { gt: since } },
        });
        if (recent >= dailyLimit) {
          this.log.warn(`password reset rate limited userId=${user.id} count=${recent}`);
          await this.audit.recordWithTx(tx, {
            tenantId: user.tenantId,
            actorUserId: user.id,
            actorType: 'user',
            action: AuditEvents.USER_PASSWORD_RESET_REQUESTED,
            resourceType: 'user',
            resourceId: user.id,
            after: { rateLimited: true, recent },
            ipAddress: input.ip,
            userAgent: input.userAgent,
          });
          return null;
        }

        await tx.passwordResetToken.create({
          data: {
            tenantId: user.tenantId,
            userId: user.id,
            tokenHash,
            expiresAt,
            requestedIp: input.ip,
            requestedUa: input.userAgent,
          },
        });

        await this.audit.recordWithTx(tx, {
          tenantId: user.tenantId,
          actorUserId: user.id,
          actorType: 'user',
          action: AuditEvents.USER_PASSWORD_RESET_REQUESTED,
          resourceType: 'user',
          resourceId: user.id,
          ipAddress: input.ip,
          userAgent: input.userAgent,
        });

        const data = {
          resetUrl: this.buildResetUrl(rawToken),
          expiresInMinutes: ttlMin,
          recipientFirstName: user.firstName,
        };
        const rowIds = await this.notifications.enqueueWithTx(tx, {
          tenantId: user.tenantId,
          templateKey: 'password_reset',
          email: input.email,
          data,
        });
        return { tenantId: user.tenantId, rowIds, data, recipientEmail: input.email };
      },
    );

    if (dispatch) {
      void this.notifications.dispatchEnqueued(
        dispatch.tenantId,
        dispatch.rowIds,
        'password_reset',
        dispatch.data,
        { email: dispatch.recipientEmail },
      );
    }
  }

  async verify(rawToken: string): Promise<VerifyResetOutput> {
    const tokenHash = hashResetToken(rawToken);
    return this.prisma.runInTenantContext(PLATFORM_TENANT, 'platform_admin', async (tx) => {
      const row = await tx.passwordResetToken.findUnique({
        where: { tokenHash },
        include: { user: { select: { email: true, firstName: true } } },
      });
      if (!row) throw new PasswordResetTokenInvalidError();
      if (row.usedAt) throw new PasswordResetTokenUsedError();
      if (row.expiresAt.getTime() < Date.now()) throw new PasswordResetTokenExpiredError();
      return {
        email: row.user.email,
        firstName: row.user.firstName,
        expiresAt: row.expiresAt,
      };
    });
  }

  async complete(input: CompleteResetInput): Promise<{ userId: string; tenantId: string }> {
    const tokenHash = hashResetToken(input.rawToken);
    return this.prisma.runInTenantContext(PLATFORM_TENANT, 'platform_admin', async (tx) => {
      const row = await tx.passwordResetToken.findUnique({
        where: { tokenHash },
        include: {
          user: { select: { id: true, tenantId: true, email: true, firstName: true, lastName: true, passwordHash: true } },
        },
      });
      if (!row) throw new PasswordResetTokenInvalidError();
      if (row.usedAt) throw new PasswordResetTokenUsedError();
      if (row.expiresAt.getTime() < Date.now()) throw new PasswordResetTokenExpiredError();

      const user = row.user;
      await this.policy.validateAll(
        tx,
        {
          tenantId: user.tenantId,
          userId: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
        },
        user.passwordHash || null,
        input.newPassword,
      );

      const newHash = await this.policy.hashForStorage(input.newPassword);
      const now = new Date();

      await tx.passwordResetToken.update({
        where: { id: row.id },
        data: { usedAt: now },
      });

      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash: newHash,
          mustChangePassword: false,
          lastPasswordChangeAt: now,
          // Successful reset clears any active lockout — the legitimate
          // owner has now demonstrated email control.
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });

      // Append the OLD hash to history (post-rotation we want to remember
      // what was rotated AWAY FROM, so future reuse checks see it).
      if (user.passwordHash && user.passwordHash.startsWith('$argon2')) {
        await tx.passwordHistory.create({
          data: { tenantId: user.tenantId, userId: user.id, passwordHash: user.passwordHash },
        });
      }

      // Reset invalidates all active sessions — anyone who held a token
      // before the rotation should be forced to sign in again.
      await tx.session.deleteMany({ where: { userId: user.id } });

      // Invalidate any other outstanding reset tokens for this user.
      await tx.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null, id: { not: row.id } },
        data: { usedAt: now },
      });

      await this.audit.recordWithTx(tx, {
        tenantId: user.tenantId,
        actorUserId: user.id,
        actorType: 'user',
        action: AuditEvents.USER_PASSWORD_RESET_COMPLETED,
        resourceType: 'user',
        resourceId: user.id,
        ipAddress: input.ip,
        userAgent: input.userAgent,
      });

      return { userId: user.id, tenantId: user.tenantId };
    });
  }

  async change(input: ChangePasswordInput): Promise<void> {
    await this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: input.userId },
        select: { id: true, tenantId: true, email: true, firstName: true, lastName: true, passwordHash: true },
      });
      if (!user) throw new CurrentPasswordIncorrectError();

      const currentOk = user.passwordHash.startsWith('$argon2')
        ? await verify(user.passwordHash, input.currentPassword)
        : false;
      if (!currentOk) throw new CurrentPasswordIncorrectError();

      await this.policy.validateAll(
        tx,
        {
          tenantId: user.tenantId,
          userId: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
        },
        user.passwordHash,
        input.newPassword,
      );

      const newHash = await this.policy.hashForStorage(input.newPassword);
      const now = new Date();

      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash: newHash,
          mustChangePassword: false,
          lastPasswordChangeAt: now,
        },
      });

      await tx.passwordHistory.create({
        data: { tenantId: user.tenantId, userId: user.id, passwordHash: user.passwordHash },
      });

      await this.audit.recordWithTx(tx, {
        tenantId: user.tenantId,
        actorUserId: user.id,
        actorType: 'user',
        action: AuditEvents.USER_PASSWORD_CHANGED,
        resourceType: 'user',
        resourceId: user.id,
        ipAddress: input.ip,
        userAgent: input.userAgent,
      });
    });
  }

  private buildResetUrl(rawToken: string): string {
    const base = this.config.get('WEB_BASE_URL', { infer: true });
    return `${base}/reset-password/${rawToken}`;
  }
}
