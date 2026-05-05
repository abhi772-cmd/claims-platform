import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { generateDoctorToken, hashDoctorToken } from './doctor-token.util';
import { HprService } from './hpr.service';
import {
  DoctorTokenExpiredError,
  DoctorTokenInvalidError,
} from '../../common/errors/auth-errors';
import { UserNotFoundError } from '../../common/errors/user-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { type AppConfig } from '../../config/configuration';
import { AuditEvents, AuditService } from '../audit';
import { NotificationService } from '../notification';

const PLATFORM_TENANT = '00000000-0000-0000-0000-000000000000';

export interface IssueDoctorTokenInput {
  tenantId: string;
  doctorUserId: string;
  createdById: string;
  caseRef: string;
  patientName: string;
  scope: 'preauth_clinical_sign';
  ip: string | null;
  userAgent: string | null;
}

export interface IssueDoctorTokenOutput {
  tokenId: string;
  expiresAt: Date;
}

export interface DoctorTokenPreviewOutput {
  doctorFirstName: string;
  doctorLastName: string;
  caseRef: string;
  patientName: string;
  scope: 'preauth_clinical_sign';
  tenantDisplayName: string;
  requesterName: string;
  expiresAt: Date;
}

export interface SignWithDoctorTokenInput {
  rawToken: string;
  hprId: string;
  hprOtp: string;
  signatureNote?: string;
  ip: string | null;
  userAgent: string | null;
}

export interface SignWithDoctorTokenOutput {
  signedAt: Date;
  doctorFullName: string;
  hprId: string;
}

@Injectable()
export class DoctorTokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly hpr: HprService,
  ) {}

  async issue(input: IssueDoctorTokenInput): Promise<IssueDoctorTokenOutput> {
    const ttlMin = this.config.get('DOCTOR_TOKEN_TTL_MINUTES', { infer: true });
    const expiresAt = new Date(Date.now() + ttlMin * 60 * 1000);
    const rawToken = generateDoctorToken();
    const tokenHash = hashDoctorToken(rawToken);

    const result = await this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      const doctor = await tx.user.findUnique({
        where: { id: input.doctorUserId },
        select: {
          id: true, tenantId: true, status: true,
          firstName: true, lastName: true, email: true, mobile: true,
        },
      });
      if (!doctor || doctor.tenantId !== input.tenantId || doctor.status !== 'active') {
        throw new UserNotFoundError();
      }
      const requester = await tx.user.findUnique({
        where: { id: input.createdById },
        select: { firstName: true, lastName: true },
      });
      const tenant = await tx.tenant.findUnique({
        where: { id: input.tenantId },
        select: { displayName: true },
      });

      const created = await tx.doctorToken.create({
        data: {
          tenantId: input.tenantId,
          doctorUserId: doctor.id,
          createdById: input.createdById,
          scope: input.scope,
          caseRef: input.caseRef,
          patientName: input.patientName,
          tokenHash,
          expiresAt,
          ipAddress: input.ip,
          userAgent: input.userAgent,
        },
      });

      await this.audit.recordWithTx(tx, {
        tenantId: input.tenantId,
        actorUserId: input.createdById,
        actorType: 'user',
        action: AuditEvents.DOCTOR_SIGNATURE_REQUESTED,
        resourceType: 'doctor_token',
        resourceId: created.id,
        after: {
          doctorUserId: doctor.id,
          caseRef: input.caseRef,
          scope: input.scope,
        },
        ipAddress: input.ip,
        userAgent: input.userAgent,
      });

      const data = {
        signUrl: this.buildSignUrl(rawToken),
        expiresInMinutes: ttlMin,
        patientName: input.patientName,
        requesterName: requester ? `${requester.firstName} ${requester.lastName}` : 'Insurance desk',
      };
      const rowIds = await this.notifications.enqueueWithTx(tx, {
        tenantId: input.tenantId,
        templateKey: 'doctor_signature_request',
        email: doctor.email,
        sms: doctor.mobile ?? undefined,
        data,
      });

      return {
        created,
        rowIds,
        data,
        recipients: { email: doctor.email, sms: doctor.mobile ?? undefined },
        tenantDisplayName: tenant?.displayName ?? '',
      };
    });

    void this.notifications.dispatchEnqueued(
      input.tenantId,
      result.rowIds,
      'doctor_signature_request',
      result.data,
      result.recipients,
    );

    return { tokenId: result.created.id, expiresAt };
  }

  async preview(rawToken: string): Promise<DoctorTokenPreviewOutput> {
    const tokenHash = hashDoctorToken(rawToken);
    return this.prisma.runInTenantContext(PLATFORM_TENANT, 'platform_admin', async (tx) => {
      const row = await tx.doctorToken.findUnique({
        where: { tokenHash },
        include: {
          doctor: { select: { firstName: true, lastName: true, tenant: { select: { displayName: true } } } },
          createdBy: { select: { firstName: true, lastName: true } },
        },
      });
      if (!row) throw new DoctorTokenInvalidError();
      if (row.usedAt) throw new DoctorTokenInvalidError();
      if (row.expiresAt.getTime() < Date.now()) throw new DoctorTokenExpiredError();
      return {
        doctorFirstName: row.doctor.firstName,
        doctorLastName: row.doctor.lastName,
        caseRef: row.caseRef,
        patientName: row.patientName,
        scope: row.scope as 'preauth_clinical_sign',
        tenantDisplayName: row.doctor.tenant.displayName,
        requesterName: `${row.createdBy.firstName} ${row.createdBy.lastName}`,
        expiresAt: row.expiresAt,
      };
    });
  }

  async sign(input: SignWithDoctorTokenInput): Promise<SignWithDoctorTokenOutput> {
    // HPR verify is OUTSIDE the tx — it talks to an external service in
    // production, and we don't want to hold a Postgres tx open while we
    // block on a network call.
    const tokenHash = hashDoctorToken(input.rawToken);

    // Pre-check the token row + capture tenantId so we can audit even
    // when HPR fails (which is itself audit-worthy).
    const row = await this.prisma.runInTenantContext(
      PLATFORM_TENANT,
      'platform_admin',
      (tx) => tx.doctorToken.findUnique({ where: { tokenHash } }),
    );
    if (!row) throw new DoctorTokenInvalidError();
    if (row.usedAt) throw new DoctorTokenInvalidError();
    if (row.expiresAt.getTime() < Date.now()) throw new DoctorTokenExpiredError();

    let verification;
    try {
      verification = await this.hpr.verify(input.hprId, input.hprOtp);
    } catch (err) {
      // Audit the failure (under platform_admin so we don't need a tenant
      // session). Then re-throw so the controller produces the right code.
      await this.audit.record({
        tenantId: row.tenantId,
        actorUserId: row.doctorUserId,
        actorType: 'user',
        action: AuditEvents.DOCTOR_SIGNATURE_TOKEN_USED,
        resourceType: 'doctor_token',
        resourceId: row.id,
        after: { reason: 'hpr_verification_failed', hprId: input.hprId },
        ipAddress: input.ip,
        userAgent: input.userAgent,
      });
      throw err;
    }

    const signedAt = new Date();
    return this.prisma.runInTenantContext(PLATFORM_TENANT, 'platform_admin', async (tx) => {
      // Re-check inside tx — covers the (rare) race where two concurrent
      // sign attempts arrive at once. Update is conditional on usedAt
      // still being null.
      const updateRes = await tx.doctorToken.updateMany({
        where: { id: row.id, usedAt: null },
        data: {
          usedAt: signedAt,
          signedHprId: verification.hprId,
          signedFullName: verification.fullName,
          signatureNote: input.signatureNote ?? null,
        },
      });
      if (updateRes.count === 0) throw new DoctorTokenInvalidError();

      await this.audit.recordWithTx(tx, {
        tenantId: row.tenantId,
        actorUserId: row.doctorUserId,
        actorType: 'user',
        action: AuditEvents.DOCTOR_SIGNED,
        resourceType: 'doctor_token',
        resourceId: row.id,
        after: {
          hprId: verification.hprId,
          fullName: verification.fullName,
          caseRef: row.caseRef,
          scope: row.scope,
        },
        ipAddress: input.ip,
        userAgent: input.userAgent,
      });

      return {
        signedAt,
        doctorFullName: verification.fullName,
        hprId: verification.hprId,
      };
    });
  }

  private buildSignUrl(rawToken: string): string {
    const base = this.config.get('WEB_BASE_URL', { infer: true });
    return `${base}/doctor-sign/${rawToken}`;
  }
}
