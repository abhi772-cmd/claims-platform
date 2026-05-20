// Slice CM — DPDP consent OTP capture flow.
//
// Two-step capture:
//   1. initiate() — operator clicks "Send OTP". We mint a 6-digit
//      code, sha256(code + pepper + otpId)-hash it, persist the row
//      with a TTL, and dispatch an SMS via the existing SmsAdapter.
//      Returns the otpId, mobileLast4, and expiresAt for the UI.
//   2. verify() — operator types the code back. We re-hash the
//      submitted code with the same otpId + pepper and compare. On
//      match, status='verified' and we return the otpId so the
//      case-create flow can attach it to GrantConsent.
//
// The OTP row is the *artifact*. It exists independently of any
// consent_record — issuance is itself a DPDP-relevant event (we sent
// PII to the patient's mobile) and gets a permanent audit row even
// if the patient never verifies.
//
// Rate limit: 5 SMS sends per (tenant, patient) per rolling hour.
// Lockout: 3 failed verify attempts → status='failed', operator must
// initiate a new OTP. Both knobs in env.
//
// Brute-force resistance: sha256(code + serverPepper + otpId). The
// otpId is the per-row salt; the pepper prevents a DB snapshot alone
// from enabling an offline 1M-code rainbow attack.

import { type ConsentType } from '@claims/contracts';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import { type AppConfig } from '../../config/configuration';

import { ValidationFailedError } from '../../common/errors/validation-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditEvents } from '../audit/audit.events';
import { AuditService } from '../audit/audit.service';
import { SmsAdapter } from '../notification/sms.adapter';

export interface InitiateOtpInput {
  tenantId: string;
  actorUserId: string;
  // Slice CM — operator-typed mobile from the intake form (E.164-ish).
  // OTP is keyed off mobile, NOT patientId, because the patient row
  // doesn't exist yet at consent-capture time.
  mobile: string;
  consentType: ConsentType;
  noticeText: string;
  locales?: string[];
}

export interface InitiateOtpResult {
  otpId: string;
  mobileLast4: string;
  expiresAt: Date;
}

export interface VerifyOtpInput {
  tenantId: string;
  actorUserId: string;
  otpId: string;
  code: string;
}

export interface VerifyOtpResult {
  otpId: string;
  verifiedAt: Date;
}

@Injectable()
export class ConsentOtpService {
  private readonly log = new Logger(ConsentOtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sms: SmsAdapter,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async initiate(input: InitiateOtpInput): Promise<InitiateOtpResult> {
    const mobile = input.mobile.replace(/\s+/g, '');
    if (!/^\+?[0-9]{8,15}$/.test(mobile)) {
      throw new ValidationFailedError(
        { mobile: ['Mobile must be 8–15 digits, optionally prefixed with +.'] },
      );
    }
    const mobileLast4 = mobile.slice(-4);

    // Per-mobile send rate limit. We count rows in the rolling hour
    // window — duplicate sends to the same mobile within the window
    // fail-fast so operator-side stuck loops don't burn SMS budget
    // or enable SMS-cost amplification attacks.
    const sendsPerHour = this.config.get('CONSENT_OTP_SENDS_PER_HOUR', { infer: true });
    const windowStart = new Date(Date.now() - 60 * 60 * 1000);
    const recent = await this.prisma.runInTenantContext(input.tenantId, 'tenant', (tx) =>
      tx.consentOtp.count({
        where: {
          tenantId: input.tenantId,
          mobileLast4,
          sentAt: { gte: windowStart },
        },
      }),
    );
    if (recent >= sendsPerHour) {
      throw new ValidationFailedError(
        { otp: [`Too many OTP requests for this mobile — try again later.`] },
        `OTP send rate limit reached (${sendsPerHour}/hour).`,
      );
    }

    const code = mintSixDigitCode();
    const otpId = generateUuid();
    const hashedOtp = hashOtp(code, otpId, this.pepper());
    const ttlMinutes = this.config.get('CONSENT_OTP_TTL_MINUTES', { infer: true });
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

    await this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      await tx.consentOtp.create({
        data: {
          id: otpId,
          tenantId: input.tenantId,
          patientId: null,
          consentType: input.consentType,
          hashedOtp,
          mobileLast4,
          gatewayMessageId: null,
          noticeText: input.noticeText,
          locales: input.locales ?? [],
          sentAt: new Date(),
          expiresAt,
          status: 'sent',
          initiatedByUserId: input.actorUserId,
        },
      });
      await this.audit.recordWithTx(tx, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        actorType: 'user',
        action: AuditEvents.CONSENT_OTP_INITIATED,
        resourceType: 'consent_otp',
        resourceId: otpId,
        after: {
          consentType: input.consentType,
          mobileLast4,
          ttlMinutes,
        },
      });
    });

    // SMS dispatch is outside the tx — the OTP row exists even if the
    // gateway rejects, so the operator can see "we tried, here's the
    // failure" instead of a silent abort. Notification failure is
    // non-fatal; the operator can resend.
    try {
      await this.sms.send(input.tenantId, mobile, {
        text: this.buildOtpSms(code, ttlMinutes),
      });
    } catch (err: unknown) {
      this.log.warn(
        `consent OTP SMS dispatch failed otpId=${otpId} mobileLast4=${mobileLast4} err=${String(
          err,
        )}`,
      );
      // Bubble up so the UI shows the operator something went wrong;
      // the OTP row is still on the table for the audit story.
      throw new ValidationFailedError(
        { sms: ['OTP could not be sent. Verify the patient mobile and retry.'] },
      );
    }

    return { otpId, mobileLast4, expiresAt };
  }

  async verify(input: VerifyOtpInput): Promise<VerifyOtpResult> {
    const maxAttempts = this.config.get('CONSENT_OTP_MAX_ATTEMPTS', { infer: true });

    return this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      const row = await tx.consentOtp.findUnique({ where: { id: input.otpId } });
      if (!row || row.tenantId !== input.tenantId) {
        throw new ValidationFailedError({ otpId: ['OTP record not found.'] });
      }
      if (row.status === 'verified') {
        // Idempotent: returning the same verifiedAt for a repeated
        // submit makes the front-end form-resubmit safe. We do NOT
        // re-check the code — the row is already in terminal state.
        return { otpId: row.id, verifiedAt: row.verifiedAt ?? new Date() };
      }
      if (row.status === 'failed') {
        throw new ValidationFailedError(
          { otp: ['Too many failed attempts on this OTP — request a new one.'] },
        );
      }
      if (row.expiresAt.getTime() <= Date.now()) {
        // Flip status so future verify attempts return the expired
        // error consistently. UPDATE doesn't change row id so the
        // operator can still see it in the audit list.
        await tx.consentOtp.update({
          where: { id: row.id },
          data: { status: 'expired' },
        });
        throw new ValidationFailedError(
          { otp: ['OTP has expired — request a new one.'] },
        );
      }

      const expected = hashOtp(input.code, row.id, this.pepper());
      // Use timingSafeEqual to avoid string-comparison side-channel
      // even though sha256 outputs are uniform-length.
      const matches = safeEqualHex(expected, row.hashedOtp);

      if (!matches) {
        const nextAttempts = row.attempts + 1;
        const lockedOut = nextAttempts >= maxAttempts;
        await tx.consentOtp.update({
          where: { id: row.id },
          data: {
            attempts: nextAttempts,
            ...(lockedOut ? { status: 'failed' } : {}),
          },
        });
        await this.audit.recordWithTx(tx, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          actorType: 'user',
          action: AuditEvents.CONSENT_OTP_VERIFY_FAILED,
          resourceType: 'consent_otp',
          resourceId: row.id,
          after: { attempts: nextAttempts, lockedOut },
        });
        throw new ValidationFailedError(
          {
            otp: lockedOut
              ? ['Maximum verification attempts exceeded — request a new OTP.']
              : ['Incorrect OTP code. Try again.'],
          },
        );
      }

      const verifiedAt = new Date();
      const updated = await tx.consentOtp.update({
        where: { id: row.id },
        data: {
          status: 'verified',
          verifiedAt,
          verifiedByUserId: input.actorUserId,
        },
      });
      await this.audit.recordWithTx(tx, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        actorType: 'user',
        action: AuditEvents.CONSENT_OTP_VERIFIED,
        resourceType: 'consent_otp',
        resourceId: updated.id,
        after: { patientId: updated.patientId, consentType: updated.consentType },
      });
      return { otpId: updated.id, verifiedAt };
    });
  }

  // Fetch a verified OTP row for use during ConsentService.grant.
  // Validates ownership (tenant), status (verified), and consent type.
  // Patient binding happens at consent-grant time: the grant path
  // updates the OTP row's patientId so the access ledger can later
  // resolve "which OTPs touched patient X" from the OTP side.
  async findVerified(
    tenantId: string,
    otpId: string,
    expectedConsentType: ConsentType,
  ): Promise<{
    id: string;
    mobileLast4: string;
    sentAt: Date;
    verifiedAt: Date;
    gatewayMessageId: string | null;
  }> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const row = await tx.consentOtp.findUnique({ where: { id: otpId } });
      if (!row || row.tenantId !== tenantId) {
        throw new ValidationFailedError({ otpId: ['OTP record not found.'] });
      }
      if (row.status !== 'verified' || !row.verifiedAt) {
        throw new ValidationFailedError(
          { otpId: ['OTP must be verified before consent can be granted.'] },
        );
      }
      if (row.consentType !== expectedConsentType) {
        throw new ValidationFailedError(
          { otpId: ['OTP was issued for a different consent type.'] },
        );
      }
      return {
        id: row.id,
        mobileLast4: row.mobileLast4,
        sentAt: row.sentAt,
        verifiedAt: row.verifiedAt,
        gatewayMessageId: row.gatewayMessageId,
      };
    });
  }

  private pepper(): string {
    return this.config.get('CONSENT_OTP_HASH_PEPPER', { infer: true });
  }

  private buildOtpSms(code: string, ttlMinutes: number): string {
    // Plain text — no patient name or sensitive details. Operator
    // controls when to send; the SMS only carries the consent code.
    return (
      `DigiSparsh: Your consent code is ${code}. ` +
      `Valid ${ttlMinutes} minutes. Do not share. ` +
      `If you did not request this, ignore.`
    );
  }
}

// 6-digit code — cryptographically random in [0, 999999], zero-padded.
function mintSixDigitCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function generateUuid(): string {
  // Avoid a separate dependency — uuid v4 shape produced from 16
  // random bytes. Same pattern Prisma uses for `default(uuid())` at
  // the column level; we generate here so we can include the id in
  // the hash input (per-row salt).
  const b = randomBytes(16);
  // Index access on Buffer returns number | undefined under
  // noUncheckedIndexedAccess; the bytes always exist on a fixed-length
  // randomBytes result, so a defensive `!` is safe and avoids changing
  // the algorithm shape.
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20, 32)
  );
}

function hashOtp(code: string, otpId: string, pepper: string): string {
  return createHash('sha256').update(`${code}|${otpId}|${pepper}`).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
