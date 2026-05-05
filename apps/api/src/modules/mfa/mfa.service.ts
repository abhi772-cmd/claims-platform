import { Injectable } from '@nestjs/common';
import { verify } from 'argon2';

import { BackupCodeService } from './backup-code.service';
import { generateChallengeId } from './challenge-token.util';
import { TotpService, type SetupArtifacts } from './totp.service';
import {
  CurrentPasswordIncorrectError,
  MfaChallengeExpiredError,
  MfaChallengeInvalidError,
  MfaInvalidError,
  MfaNotEnrolledError,
  MfaSetupNotPendingError,
  MfaAlreadyEnrolledError,
} from '../../common/errors/auth-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { type TenantPrisma } from '../../types/express';
import { AuditEvents, AuditService } from '../audit';

const PLATFORM_TENANT = '00000000-0000-0000-0000-000000000000';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface SetupOutput extends SetupArtifacts {}

export interface ConfirmOutput {
  backupCodes: string[];
}

export interface IssueChallengeInput {
  tenantId: string;
  userId: string;
  ip: string | null;
  userAgent: string | null;
}

export interface IssueChallengeOutput {
  challengeId: string;
  expiresAt: Date;
}

export interface VerifyChallengeInput {
  challengeId: string;
  code: string;
  ip: string | null;
  userAgent: string | null;
}

export interface VerifyChallengeOutput {
  userId: string;
  tenantId: string;
}

@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly totp: TotpService,
    private readonly backupCodes: BackupCodeService,
    private readonly audit: AuditService,
  ) {}

  // Begin enrollment. Generates a fresh secret + QR. If the user already
  // has a confirmed enrollment we refuse (rotate via disable+setup).
  async setup(tenantId: string, userId: string, accountEmail: string): Promise<SetupOutput> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const existing = await tx.mfaEnrollment.findUnique({ where: { userId } });
      if (existing?.confirmedAt) throw new MfaAlreadyEnrolledError();
      const artifacts = await this.totp.generateSetup(accountEmail);
      if (existing) {
        await tx.mfaEnrollment.update({
          where: { userId },
          data: { secret: artifacts.secret, confirmedAt: null, lastUsedStep: null },
        });
      } else {
        await tx.mfaEnrollment.create({
          data: { tenantId, userId, secret: artifacts.secret },
        });
      }
      return artifacts;
    });
  }

  // Finish enrollment by proving possession of the new secret. On success
  // we flip confirmedAt, set user.mfaEnabled = true, and issue 10 backup
  // codes (returned ONCE). Burns any prior backup codes.
  async confirm(
    tenantId: string,
    userId: string,
    code: string,
    ip: string | null,
    userAgent: string | null,
  ): Promise<ConfirmOutput> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const pending = await tx.mfaEnrollment.findUnique({ where: { userId } });
      if (!pending) throw new MfaSetupNotPendingError();
      if (pending.confirmedAt) throw new MfaAlreadyEnrolledError();
      const step = this.totp.verifyAndGetStep(code, pending.secret);
      if (step === null) throw new MfaInvalidError();

      const { raw, hashes } = this.backupCodes.generateBatch();
      const now = new Date();

      await tx.mfaEnrollment.update({
        where: { userId },
        data: { confirmedAt: now, lastUsedStep: BigInt(step) },
      });
      await tx.user.update({
        where: { id: userId },
        data: { mfaEnabled: true, mfaSecret: pending.secret },
      });
      // Replace any prior backup codes with the new batch.
      await tx.backupCode.deleteMany({ where: { userId } });
      await tx.backupCode.createMany({
        data: hashes.map((codeHash) => ({ tenantId, userId, codeHash })),
      });

      await this.audit.recordWithTx(tx, {
        tenantId,
        actorUserId: userId,
        actorType: 'user',
        action: AuditEvents.USER_MFA_ENROLLED,
        resourceType: 'user',
        resourceId: userId,
        ipAddress: ip,
        userAgent,
      });

      return { backupCodes: raw };
    });
  }

  async disable(
    tenantId: string,
    userId: string,
    currentPassword: string,
    code: string,
    ip: string | null,
    userAgent: string | null,
  ): Promise<void> {
    await this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new CurrentPasswordIncorrectError();
      const ok = user.passwordHash.startsWith('$argon2')
        ? await verify(user.passwordHash, currentPassword)
        : false;
      if (!ok) throw new CurrentPasswordIncorrectError();
      if (!user.mfaEnabled) throw new MfaNotEnrolledError();

      // Verify either a TOTP or a backup code as the second proof.
      await this.consumeSecondFactor(tx, userId, code);

      await tx.mfaEnrollment.delete({ where: { userId } }).catch(() => undefined);
      await tx.backupCode.deleteMany({ where: { userId } });
      await tx.user.update({
        where: { id: userId },
        data: { mfaEnabled: false, mfaSecret: null },
      });
      await this.audit.recordWithTx(tx, {
        tenantId,
        actorUserId: userId,
        actorType: 'user',
        action: AuditEvents.USER_MFA_DISABLED,
        resourceType: 'user',
        resourceId: userId,
        ipAddress: ip,
        userAgent,
      });
    });
  }

  async regenerateBackupCodes(
    tenantId: string,
    userId: string,
    currentPassword: string,
    ip: string | null,
    userAgent: string | null,
  ): Promise<string[]> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new CurrentPasswordIncorrectError();
      const ok = user.passwordHash.startsWith('$argon2')
        ? await verify(user.passwordHash, currentPassword)
        : false;
      if (!ok) throw new CurrentPasswordIncorrectError();
      if (!user.mfaEnabled) throw new MfaNotEnrolledError();

      const { raw, hashes } = this.backupCodes.generateBatch();
      await tx.backupCode.deleteMany({ where: { userId } });
      await tx.backupCode.createMany({
        data: hashes.map((codeHash) => ({ tenantId, userId, codeHash })),
      });

      await this.audit.recordWithTx(tx, {
        tenantId,
        actorUserId: userId,
        actorType: 'user',
        action: AuditEvents.USER_MFA_ENROLLED, // overload: backup-codes regen
        resourceType: 'user',
        resourceId: userId,
        after: { event: 'backup_codes_regenerated' },
        ipAddress: ip,
        userAgent,
      });

      return raw;
    });
  }

  async issueChallenge(input: IssueChallengeInput): Promise<IssueChallengeOutput> {
    const challengeId = generateChallengeId();
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
    return this.prisma.runInTenantContext(PLATFORM_TENANT, 'platform_admin', async (tx) => {
      await tx.mfaChallenge.create({
        data: {
          tenantId: input.tenantId,
          userId: input.userId,
          challengeId,
          expiresAt,
          ipAddress: input.ip,
          userAgent: input.userAgent,
        },
      });
      return { challengeId, expiresAt };
    });
  }

  async verifyChallenge(input: VerifyChallengeInput): Promise<VerifyChallengeOutput> {
    return this.prisma.runInTenantContext(PLATFORM_TENANT, 'platform_admin', async (tx) => {
      const row = await tx.mfaChallenge.findUnique({
        where: { challengeId: input.challengeId },
      });
      if (!row) throw new MfaChallengeInvalidError();
      if (row.consumedAt) throw new MfaChallengeInvalidError();
      if (row.expiresAt.getTime() < Date.now()) throw new MfaChallengeExpiredError();

      await this.consumeSecondFactor(tx, row.userId, input.code);

      await tx.mfaChallenge.update({
        where: { id: row.id },
        data: { consumedAt: new Date() },
      });
      return { userId: row.userId, tenantId: row.tenantId };
    });
  }

  // Shared verify path: a "code" can be a 6-digit TOTP or a backup code.
  // On TOTP success we update lastUsedStep to block replay. On backup-code
  // success we mark the row used.
  private async consumeSecondFactor(
    tx: TenantPrisma,
    userId: string,
    rawCode: string,
  ): Promise<void> {
    const enrollment = await tx.mfaEnrollment.findUnique({ where: { userId } });
    if (!enrollment || !enrollment.confirmedAt) throw new MfaNotEnrolledError();

    if (this.backupCodes.looksLikeBackupCode(rawCode)) {
      const codeHash = this.backupCodes.hash(rawCode);
      const row = await tx.backupCode.findUnique({ where: { codeHash } });
      if (!row || row.userId !== userId || row.usedAt) {
        throw new MfaInvalidError();
      }
      await tx.backupCode.update({
        where: { id: row.id },
        data: { usedAt: new Date() },
      });
      return;
    }

    const step = this.totp.verifyAndGetStep(rawCode, enrollment.secret);
    if (step === null) throw new MfaInvalidError();
    if (enrollment.lastUsedStep !== null && BigInt(step) <= enrollment.lastUsedStep) {
      throw new MfaInvalidError();
    }
    await tx.mfaEnrollment.update({
      where: { userId },
      data: { lastUsedStep: BigInt(step) },
    });
  }
}
