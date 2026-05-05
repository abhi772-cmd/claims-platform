import { createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { verify } from 'argon2';

import { type JwtPayload } from './jwt.strategy';
import {
  AccountLockedError,
  InvalidCredentialsError,
  RefreshTokenInvalidError,
  RefreshTokenReuseDetectedError,
  TenantDisabledError,
} from '../../common/errors/auth-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { type AppConfig } from '../../config/configuration';
import { AuditEvents, AuditService } from '../audit';
import { MfaService } from '../mfa';
import { IpAllowlistService, SessionService, TrustedDeviceService } from '../security';

const FAILED_ATTEMPTS_LIMIT = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

export interface LoginInput {
  email: string;
  password: string;
  // Optional raw trusted-device token from the claims_trust cookie. When
  // present and valid for this user, the MFA challenge is skipped.
  trustedDeviceToken?: string | null;
}

export interface LoginSuccessOutput {
  kind: 'success';
  accessToken: string;
  refreshToken: string;
  // True when this success was reached via a trusted-device cookie skip
  // (caller may want to log it separately). False on every other path.
  trustedDeviceUsed?: boolean;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    tenantId: string;
    mustChangePassword: boolean;
  };
}

export interface LoginMfaRequiredOutput {
  kind: 'mfa_required';
  challengeId: string;
  expiresAt: Date;
}

export type LoginOutput = LoginSuccessOutput | LoginMfaRequiredOutput;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly audit: AuditService,
    private readonly mfa: MfaService,
    private readonly ipAllowlist: IpAllowlistService,
    private readonly trustedDevices: TrustedDeviceService,
    private readonly sessions: SessionService,
  ) {}

  async login(input: LoginInput, userAgent: string | null, ip: string | null): Promise<LoginOutput> {
    // Three-phase split:
    //   1. Read-only lookup of the user.
    //   2. On failure paths (bad password, locked, tenant disabled), open a
    //      SEPARATE write tx to commit side effects (counter, lockout, audit
    //      row) before throwing — otherwise the throw rolls back the lockout
    //      counter and we never actually lock the account.
    //   3. On success, open a third write tx for session + audit + counter
    //      reset.
    const user = await this.prisma.runInTenantContext(
      '00000000-0000-0000-0000-000000000000',
      'platform_admin',
      (tx) =>
        tx.user.findUnique({
          where: { email: input.email },
          include: {
            tenant: { select: { id: true, lifecycleState: true } },
            userRoles: { include: { role: true } },
          },
        }),
    );

    if (!user) {
      // Argon2 verify on a dummy hash so response time doesn't leak existence.
      await verify(DUMMY_ARGON2_HASH, input.password).catch(() => false);
      throw new InvalidCredentialsError();
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      await this.audit.record({
        tenantId: user.tenantId,
        actorUserId: user.id,
        actorType: 'user',
        action: AuditEvents.USER_FAILED_LOGIN,
        resourceType: 'user',
        resourceId: user.id,
        after: { reason: 'account_locked' },
        ipAddress: ip,
        userAgent,
      });
      throw new AccountLockedError();
    }

    const ok = await verify(user.passwordHash, input.password);
    if (!ok) {
      const attempts = user.failedLoginAttempts + 1;
      const shouldLock = attempts >= FAILED_ATTEMPTS_LIMIT;
      await this.prisma.runInTenantContext(
        '00000000-0000-0000-0000-000000000000',
        'platform_admin',
        async (tx) => {
          await tx.user.update({
            where: { id: user.id },
            data: {
              failedLoginAttempts: attempts,
              lockedUntil: shouldLock ? new Date(Date.now() + LOCK_DURATION_MS) : user.lockedUntil,
            },
          });
          await this.audit.recordWithTx(tx, {
            tenantId: user.tenantId,
            actorUserId: user.id,
            actorType: 'user',
            action: shouldLock ? AuditEvents.USER_LOCKED : AuditEvents.USER_FAILED_LOGIN,
            resourceType: 'user',
            resourceId: user.id,
            after: { attempts, reason: shouldLock ? 'too_many_attempts' : 'wrong_password' },
            ipAddress: ip,
            userAgent,
          });
        },
      );
      throw shouldLock ? new AccountLockedError() : new InvalidCredentialsError();
    }

    if (user.tenant.lifecycleState === 'SUSPENDED' || user.tenant.lifecycleState === 'CHURNED') {
      await this.audit.record({
        tenantId: user.tenantId,
        actorUserId: user.id,
        actorType: 'user',
        action: AuditEvents.USER_FAILED_LOGIN,
        resourceType: 'user',
        resourceId: user.id,
        after: { reason: 'tenant_disabled', tenantState: user.tenant.lifecycleState },
        ipAddress: ip,
        userAgent,
      });
      throw new TenantDisabledError();
    }

    // IP allowlist enforcement. We check AFTER password verification so we
    // don't leak the existence of an allowlist to an attacker probing
    // random emails. platform_admin role bypasses (they may need to
    // intervene from anywhere); otherwise the request IP must match one
    // of the tenant's CIDR ranges (if any are configured).
    const isPlatformAdmin = user.userRoles.some((ur) => ur.role.name === 'platform_admin');
    try {
      await this.ipAllowlist.assertAllowed(user.tenantId, ip, isPlatformAdmin);
    } catch (err) {
      await this.audit.record({
        tenantId: user.tenantId,
        actorUserId: user.id,
        actorType: 'user',
        action: AuditEvents.USER_FAILED_LOGIN,
        resourceType: 'user',
        resourceId: user.id,
        after: { reason: 'ip_not_allowed', ip },
        ipAddress: ip,
        userAgent,
      });
      throw err;
    }

    // Password is correct. If MFA is enabled, short-circuit to a challenge —
    // unless the request carries a trusted-device cookie that resolves to
    // this user, in which case we skip MFA and finalize directly.
    if (user.mfaEnabled) {
      if (input.trustedDeviceToken) {
        const trusted = await this.trustedDevices.resolve(
          input.trustedDeviceToken,
          user.id,
          userAgent,
        );
        if (trusted) {
          const finalized = await this.finalizeLogin(user.id, user.tenantId, userAgent, ip);
          return { ...finalized, trustedDeviceUsed: true };
        }
      }
      const challenge = await this.mfa.issueChallenge({
        tenantId: user.tenantId,
        userId: user.id,
        ip,
        userAgent,
      });
      return {
        kind: 'mfa_required',
        challengeId: challenge.challengeId,
        expiresAt: challenge.expiresAt,
      };
    }

    return this.finalizeLogin(user.id, user.tenantId, userAgent, ip);
  }

  // Completes login after a successful MFA challenge. Used by /auth/mfa/verify.
  // Re-loads the user (we don't trust anything from the challenge row beyond
  // userId + tenantId) and runs the same finalize path as the no-MFA branch.
  async completeMfa(
    challengeId: string,
    code: string,
    userAgent: string | null,
    ip: string | null,
  ): Promise<LoginSuccessOutput> {
    const verified = await this.mfa.verifyChallenge({ challengeId, code, ip, userAgent });
    return this.finalizeLogin(verified.userId, verified.tenantId, userAgent, ip);
  }

  private async finalizeLogin(
    userId: string,
    tenantId: string,
    userAgent: string | null,
    ip: string | null,
  ): Promise<LoginSuccessOutput> {
    const refreshToken = generateOpaqueToken();
    const refreshHash = hashToken(refreshToken);
    const refreshExpiresAt = new Date(
      Date.now() + parseDurationMs(this.config.get('JWT_REFRESH_TTL', { infer: true })),
    );

    const result = await this.prisma.runInTenantContext(
      '00000000-0000-0000-0000-000000000000',
      'platform_admin',
      async (tx) => {
        const user = await tx.user.findUnique({
          where: { id: userId },
          include: {
            tenant: { select: { id: true } },
            userRoles: { include: { role: true } },
          },
        });
        if (!user) throw new InvalidCredentialsError();

        // Enforce concurrent-session cap before creating the new session.
        await this.sessions.enforceCapBeforeCreate(tx, user.tenantId, user.id);

        const session = await tx.session.create({
          data: {
            userId: user.id,
            tenantId: user.tenantId,
            refreshTokenHash: refreshHash,
            userAgent: userAgent ?? null,
            ipAddress: ip ?? null,
            expiresAt: refreshExpiresAt,
          },
        });
        await tx.user.update({
          where: { id: user.id },
          data: {
            failedLoginAttempts: 0,
            lockedUntil: null,
            lastLoginAt: new Date(),
            lastLoginIp: ip ?? null,
            lastLoginUserAgent: userAgent ?? null,
          },
        });
        await this.audit.recordWithTx(tx, {
          tenantId: user.tenantId,
          actorUserId: user.id,
          actorType: 'user',
          action: AuditEvents.USER_LOGGED_IN,
          resourceType: 'session',
          resourceId: session.id,
          ipAddress: ip,
          userAgent,
        });
        return { user, session };
      },
    );

    const roleNames = result.user.userRoles.map((ur) => ur.role.name);
    const permissions = unionPermissions(result.user.userRoles);
    const isPlatformAdmin = roleNames.includes('platform_admin');
    const accessToken = this.signAccessToken({
      sub: result.user.id,
      tid: result.user.tenantId,
      rl: isPlatformAdmin ? 'platform_admin' : 'tenant',
      rs: roleNames,
      pm: permissions,
      sid: result.session.id,
    });

    return {
      kind: 'success',
      accessToken,
      refreshToken,
      user: {
        id: result.user.id,
        email: result.user.email,
        firstName: result.user.firstName,
        lastName: result.user.lastName,
        tenantId: result.user.tenantId,
        mustChangePassword: result.user.mustChangePassword,
      },
    };
    // tenantId is read off the loaded user; the parameter `tenantId` above
    // is reserved for forward-compat with cross-tenant flows.
    void tenantId;
  }

  async refresh(opaqueRefreshToken: string, userAgent: string | null, ip: string | null): Promise<{
    accessToken: string;
    refreshToken: string;
  }> {
    const presented = hashToken(opaqueRefreshToken);
    return this.prisma.runInTenantContext(
      '00000000-0000-0000-0000-000000000000',
      'platform_admin',
      async (tx) => {
        const session = await tx.session.findUnique({
          where: { refreshTokenHash: presented },
          include: {
            user: { include: { userRoles: { include: { role: true } } } },
          },
        });
        if (!session) {
          // Reuse detection: was this hash ever seen as a previous (rotated)
          // session? If yes, that's reuse — kill all sessions for the user.
          const previous = await tx.sessionTokenHistory.findUnique({
            where: { refreshTokenHash: presented },
          });
          if (previous) {
            await tx.session.deleteMany({ where: { userId: previous.userId } });
            throw new RefreshTokenReuseDetectedError();
          }
          throw new RefreshTokenInvalidError();
        }

        if (session.revokedAt || session.expiresAt.getTime() < Date.now()) {
          throw new RefreshTokenInvalidError();
        }

        const newRefreshToken = generateOpaqueToken();
        const newRefreshHash = hashToken(newRefreshToken);
        const newRefreshExpiresAt = new Date(
          Date.now() + parseDurationMs(this.config.get('JWT_REFRESH_TTL', { infer: true })),
        );

        await tx.sessionTokenHistory.create({
          data: {
            sessionId: session.id,
            userId: session.userId,
            refreshTokenHash: presented,
            rotatedAt: new Date(),
          },
        });

        await tx.session.update({
          where: { id: session.id },
          data: {
            refreshTokenHash: newRefreshHash,
            expiresAt: newRefreshExpiresAt,
            userAgent: userAgent ?? session.userAgent,
            ipAddress: ip ?? session.ipAddress,
          },
        });

        const roleNames = session.user.userRoles.map((ur) => ur.role.name);
        const permissions = unionPermissions(session.user.userRoles);
        const isPlatformAdmin = roleNames.includes('platform_admin');
        const accessToken = this.signAccessToken({
          sub: session.userId,
          tid: session.tenantId,
          rl: isPlatformAdmin ? 'platform_admin' : 'tenant',
          rs: roleNames,
          pm: permissions,
          sid: session.id,
        });

        return { accessToken, refreshToken: newRefreshToken };
      },
    );
  }

  async logout(opaqueRefreshToken: string | null): Promise<void> {
    if (!opaqueRefreshToken) return;
    const presented = hashToken(opaqueRefreshToken);
    await this.prisma.runInTenantContext(
      '00000000-0000-0000-0000-000000000000',
      'platform_admin',
      async (tx) => {
        const session = await tx.session.findUnique({
          where: { refreshTokenHash: presented },
        });
        if (!session) return;
        await tx.session.delete({ where: { id: session.id } });
        await this.audit.recordWithTx(tx, {
          tenantId: session.tenantId,
          actorUserId: session.userId,
          actorType: 'user',
          action: AuditEvents.USER_LOGGED_OUT,
          resourceType: 'session',
          resourceId: session.id,
        });
      },
    );
  }

  private signAccessToken(payload: JwtPayload): string {
    return this.jwt.sign(payload);
  }
}

function unionPermissions(
  userRoles: { role: { permissions: unknown } }[],
): string[] {
  const set = new Set<string>();
  for (const ur of userRoles) {
    const perms = ur.role.permissions;
    if (Array.isArray(perms)) {
      for (const p of perms) {
        if (typeof p === 'string') set.add(p);
      }
    }
  }
  return Array.from(set).sort();
}

function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function parseDurationMs(input: string): number {
  const m = /^(\d+)\s*(ms|s|m|h|d)$/.exec(input.trim());
  if (!m) throw new Error(`Invalid duration: ${input}`);
  const n = Number(m[1]);
  const unit = m[2];
  switch (unit) {
    case 'ms':
      return n;
    case 's':
      return n * 1000;
    case 'm':
      return n * 60 * 1000;
    case 'h':
      return n * 60 * 60 * 1000;
    case 'd':
      return n * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`Invalid duration unit: ${String(unit)}`);
  }
}

// Pre-computed argon2 hash for a random throwaway password. Used as a
// constant-time foil when the email isn't found, so login response time
// doesn't leak account existence.
const DUMMY_ARGON2_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$ZHVtbXlzYWx0ZHVtbXlzYWx0$Y0E9HnP+B0E0gO8JYoH7Q1QH3dQUvCgZb6mO0qY77SE';
