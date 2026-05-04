import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { generateInviteToken, hashInviteToken } from './invite-token.util';
import {
  InviteTokenExpiredError,
  InviteTokenRevokedError,
  InviteTokenUsedError,
} from '../../common/errors/auth-errors';
import {
  InviteNotPendingError,
  InviteRateLimitReachedError,
  UserAlreadyExistsError,
  UserNotFoundError,
} from '../../common/errors/user-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { type AppConfig } from '../../config/configuration';
import { AuditEvents, AuditService } from '../audit';
import { NotificationService } from '../notification';
import { PasswordPolicyService } from '../password';

export interface InviteUserInput {
  tenantId: string;
  invitedById: string;
  email: string;
  firstName: string;
  lastName: string;
  mobile?: string;
  designation?: string;
  roles: string[]; // role names; resolved to ids inside the tx
}

export interface AcceptInviteInput {
  rawToken: string;
  password: string;
}

export interface InvitedUserSummary {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  status: 'invited';
  inviteExpiresAt: Date;
}

@Injectable()
export class InviteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly passwordPolicy: PasswordPolicyService,
  ) {}

  async invite(
    input: InviteUserInput,
    actorIp: string | null,
    actorUserAgent: string | null,
  ): Promise<InvitedUserSummary> {
    const ttlHours = this.config.get('INVITE_TOKEN_TTL_HOURS', { infer: true });
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
    const rawToken = generateInviteToken();
    const tokenHash = hashInviteToken(rawToken);

    const result = await this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      const existing = await tx.user.findUnique({ where: { email: input.email } });
      if (existing) throw new UserAlreadyExistsError();

      const roleRows = await tx.role.findMany({
        where: { tenantId: input.tenantId, name: { in: input.roles } },
      });
      if (roleRows.length !== input.roles.length) {
        throw new UserNotFoundError(); // role-not-found shape; refine in Slice G
      }

      const tenant = await tx.tenant.findUnique({
        where: { id: input.tenantId },
        select: { displayName: true },
      });
      if (!tenant) throw new UserNotFoundError();

      const inviter = await tx.user.findUnique({
        where: { id: input.invitedById },
        select: { firstName: true, lastName: true },
      });

      const created = await tx.user.create({
        data: {
          tenantId: input.tenantId,
          email: input.email,
          mobile: input.mobile ?? null,
          // Empty password hash — replaced on accept-invite.
          passwordHash: '',
          status: 'invited',
          firstName: input.firstName,
          lastName: input.lastName,
          designation: input.designation ?? null,
          mustChangePassword: false,
          inviteTokenHash: tokenHash,
          inviteTokenExpiresAt: expiresAt,
          invitedById: input.invitedById,
        },
      });

      await tx.userRole.createMany({
        data: roleRows.map((r) => ({
          tenantId: input.tenantId,
          userId: created.id,
          roleId: r.id,
        })),
      });

      await this.audit.recordWithTx(tx, {
        tenantId: input.tenantId,
        actorUserId: input.invitedById,
        actorType: 'user',
        action: AuditEvents.USER_INVITED,
        resourceType: 'user',
        resourceId: created.id,
        after: { email: input.email, roles: input.roles },
        ipAddress: actorIp,
        userAgent: actorUserAgent,
      });

      const outboxRowIds = await this.notifications.enqueueWithTx(tx, {
        tenantId: input.tenantId,
        templateKey: 'user_invitation',
        email: input.email,
        sms: input.mobile ?? undefined,
        data: {
          inviteUrl: this.buildInviteUrl(rawToken),
          inviterName: inviter ? `${inviter.firstName} ${inviter.lastName}` : 'Your admin',
          tenantDisplayName: tenant.displayName,
          expiresInHours: ttlHours,
          recipientFirstName: input.firstName,
        },
      });

      return { created, outboxRowIds, tenantDisplayName: tenant.displayName, inviter };
    });

    // Notification dispatch happens after tx commits — failure does not roll
    // back the invite. The outbox row's status reflects the dispatch outcome.
    const inviterName = result.inviter
      ? `${result.inviter.firstName} ${result.inviter.lastName}`
      : 'Your admin';
    void this.notifications.dispatchEnqueued(
      input.tenantId,
      result.outboxRowIds,
      'user_invitation',
      {
        inviteUrl: this.buildInviteUrl(rawToken),
        inviterName,
        tenantDisplayName: result.tenantDisplayName,
        expiresInHours: ttlHours,
        recipientFirstName: input.firstName,
      },
      { email: input.email, sms: input.mobile ?? undefined },
    );

    return {
      id: result.created.id,
      email: result.created.email,
      firstName: result.created.firstName,
      lastName: result.created.lastName,
      status: 'invited',
      inviteExpiresAt: expiresAt,
    };
  }

  async resend(
    tenantId: string,
    targetUserId: string,
    actorUserId: string,
    actorIp: string | null,
    actorUserAgent: string | null,
  ): Promise<{ inviteExpiresAt: Date }> {
    const ttlHours = this.config.get('INVITE_TOKEN_TTL_HOURS', { infer: true });
    const limit = this.config.get('INVITE_RESEND_LIMIT_PER_DAY', { infer: true });
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
    const rawToken = generateInviteToken();
    const tokenHash = hashInviteToken(rawToken);

    const result = await this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const target = await tx.user.findUnique({ where: { id: targetUserId } });
      if (!target || target.tenantId !== tenantId) throw new UserNotFoundError();
      if (target.status !== 'invited' || target.inviteAcceptedAt) {
        throw new InviteNotPendingError();
      }

      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recent = await tx.inviteResend.count({
        where: { tenantId, userId: targetUserId, resentAt: { gt: since } },
      });
      if (recent >= limit) {
        throw new InviteRateLimitReachedError(
          `Limit is ${limit} resends per 24 hours; you've used ${recent}.`,
        );
      }

      const updated = await tx.user.update({
        where: { id: targetUserId },
        data: {
          inviteTokenHash: tokenHash,
          inviteTokenExpiresAt: expiresAt,
        },
      });
      await tx.inviteResend.create({
        data: { tenantId, userId: targetUserId, resentBy: actorUserId },
      });

      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { displayName: true },
      });
      const inviter = await tx.user.findUnique({
        where: { id: actorUserId },
        select: { firstName: true, lastName: true },
      });

      await this.audit.recordWithTx(tx, {
        tenantId,
        actorUserId,
        actorType: 'user',
        action: AuditEvents.USER_INVITE_RESENT,
        resourceType: 'user',
        resourceId: targetUserId,
        ipAddress: actorIp,
        userAgent: actorUserAgent,
      });

      const outboxRowIds = await this.notifications.enqueueWithTx(tx, {
        tenantId,
        templateKey: 'user_invitation',
        email: updated.email,
        sms: updated.mobile ?? undefined,
        data: {
          inviteUrl: this.buildInviteUrl(rawToken),
          inviterName: inviter ? `${inviter.firstName} ${inviter.lastName}` : 'Your admin',
          tenantDisplayName: tenant?.displayName ?? '',
          expiresInHours: ttlHours,
          recipientFirstName: updated.firstName,
        },
      });

      return { updated, outboxRowIds, tenant, inviter };
    });

    const inviterName = result.inviter
      ? `${result.inviter.firstName} ${result.inviter.lastName}`
      : 'Your admin';
    void this.notifications.dispatchEnqueued(
      tenantId,
      result.outboxRowIds,
      'user_invitation',
      {
        inviteUrl: this.buildInviteUrl(rawToken),
        inviterName,
        tenantDisplayName: result.tenant?.displayName ?? '',
        expiresInHours: ttlHours,
        recipientFirstName: result.updated.firstName,
      },
      { email: result.updated.email, sms: result.updated.mobile ?? undefined },
    );

    return { inviteExpiresAt: expiresAt };
  }

  async preview(rawToken: string): Promise<{
    email: string;
    firstName: string;
    lastName: string;
    tenantDisplayName: string;
    roles: string[];
    expiresAt: Date;
  }> {
    const tokenHash = hashInviteToken(rawToken);
    return this.prisma.runInTenantContext(
      '00000000-0000-0000-0000-000000000000',
      'platform_admin',
      async (tx) => {
        const user = await tx.user.findUnique({
          where: { inviteTokenHash: tokenHash },
          include: {
            tenant: { select: { displayName: true } },
            userRoles: { include: { role: true } },
          },
        });
        if (!user) throw new InviteTokenRevokedError();
        if (user.inviteAcceptedAt) throw new InviteTokenUsedError();
        if (!user.inviteTokenExpiresAt || user.inviteTokenExpiresAt.getTime() < Date.now()) {
          throw new InviteTokenExpiredError();
        }
        return {
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          tenantDisplayName: user.tenant.displayName,
          roles: user.userRoles.map((ur) => ur.role.name),
          expiresAt: user.inviteTokenExpiresAt,
        };
      },
    );
  }

  async accept(
    input: AcceptInviteInput,
    ip: string | null,
    userAgent: string | null,
  ): Promise<{ userId: string; tenantId: string }> {
    const tokenHash = hashInviteToken(input.rawToken);
    return this.prisma.runInTenantContext(
      '00000000-0000-0000-0000-000000000000',
      'platform_admin',
      async (tx) => {
        const user = await tx.user.findUnique({ where: { inviteTokenHash: tokenHash } });
        if (!user) throw new InviteTokenRevokedError();
        if (user.inviteAcceptedAt) throw new InviteTokenUsedError();
        if (!user.inviteTokenExpiresAt || user.inviteTokenExpiresAt.getTime() < Date.now()) {
          throw new InviteTokenExpiredError();
        }

        // Full policy: shape + breach + reuse. The reuse check has nothing
        // to compare against on first accept (passwordHash is empty), but
        // it's the same code path we use for resets and self-changes so we
        // run it for consistency.
        await this.passwordPolicy.validateAll(
          tx,
          {
            tenantId: user.tenantId,
            userId: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
          },
          user.passwordHash || null,
          input.password,
        );

        const passwordHash = await this.passwordPolicy.hashForStorage(input.password);
        const now = new Date();

        await tx.user.update({
          where: { id: user.id },
          data: {
            passwordHash,
            status: 'active',
            inviteAcceptedAt: now,
            inviteTokenHash: null,
            inviteTokenExpiresAt: null,
            lastPasswordChangeAt: now,
          },
        });
        await this.audit.recordWithTx(tx, {
          tenantId: user.tenantId,
          actorUserId: user.id,
          actorType: 'user',
          action: AuditEvents.USER_ACCEPTED_INVITE,
          resourceType: 'user',
          resourceId: user.id,
          ipAddress: ip,
          userAgent,
        });
        return { userId: user.id, tenantId: user.tenantId };
      },
    );
  }

  private buildInviteUrl(rawToken: string): string {
    const base = this.config.get('WEB_BASE_URL', { infer: true });
    return `${base}/accept-invite/${rawToken}`;
  }
}
