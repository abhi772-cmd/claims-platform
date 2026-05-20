// Slice BT — DPDP Act 2023 §6 / Rule 8 consent record service.
//
// Three primary call paths:
//   - grant()             — operator captures a new consent at admission.
//   - withdraw()          — data principal exercises §13 right.
//   - findActiveFor(...)  — service callers ask "is there a non-expired,
//                           non-withdrawn grant covering (patient, type)?"
//                           Returns the row so callers can thread its id
//                           into data_access_event.consentGrantId.
//
// `requireConsent()` is the call-site guard — throws a domain error
// when no active grant covers the (patient, type) tuple. Service code
// gating PII reads should use this; pure-data list paths (e.g.
// case index where Patient.fullName is intentionally redacted)
// don't need it.
//
// Append-only on DELETE; UPDATE is permitted by RLS for status flips
// (granted → withdrawn / expired). The legal sequencing is enforced
// here, not the database.

import {
  type AcknowledgementMethod,
  type ConsentEvidence,
  type ConsentRecordRow,
  type ConsentStatus,
  type ConsentType,
  type LawfulBasis,
} from '@claims/contracts';
import { Injectable } from '@nestjs/common';


import { ValidationFailedError } from '../../common/errors/validation-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { type TenantPrisma } from '../../types/express';
import { AuditEvents } from '../audit/audit.events';
import { AuditService } from '../audit/audit.service';

export interface GrantConsentInput {
  tenantId: string;
  actorUserId: string;
  patientId: string;
  consentType: ConsentType;
  dataCategories: string[];
  purposes: string[];
  lawfulBasis: LawfulBasis;
  source: string;
  evidence: ConsentEvidence;
  expiresAt?: Date;
  documentId?: string;
  // Slice CM — typed acknowledgement method + ref into the per-method
  // artifact table. Optional for backward compatibility: legacy intake
  // paths that only set `source` continue to work and land with both
  // columns NULL.
  acknowledgementMethod?: AcknowledgementMethod;
  acknowledgementRef?: string;
}

export interface WithdrawConsentInput {
  tenantId: string;
  actorUserId: string;
  consentId: string;
  reason: string;
}

export interface ListConsentsInput {
  tenantId: string;
  patientId?: string;
  consentType?: string;
  status?: string;
}

@Injectable()
export class ConsentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // Operator-captured grant. Lands status='granted'. The same
  // (patient, consentType) can have multiple historical rows over
  // time — withdrawn / expired rows aren't deleted, they sit
  // alongside the latest granted one. Callers reading via
  // findActiveFor get the most-recent active row.
  async grant(input: GrantConsentInput): Promise<ConsentRecordRow> {
    return this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) =>
      this.grantWithTx(tx, input),
    );
  }

  // Slice CF — same shape as grant() but runs inside a caller's
  // existing tenant tx. Used by CaseService.create so the consent
  // record commits atomically with the Patient + Case rows. Without
  // this variant the intake flow would write three separate
  // transactions (patient, case, consent), and a failure in the
  // third would leave a Case + Patient with no consent — exactly
  // the situation the BU dashboard's "unbound access" signal is
  // built to surface, but better to never create the row at all.
  async grantWithTx(tx: TenantPrisma, input: GrantConsentInput): Promise<ConsentRecordRow> {
    // Verify patient exists and belongs to this tenant. Cheap
    // round-trip; the caller may have just created the patient
    // in the same tx, so this both validates and confirms the
    // earlier insert is visible to subsequent reads.
    const patient = await tx.patient.findUnique({
      where: { id: input.patientId },
      select: { id: true, tenantId: true },
    });
    if (!patient || patient.tenantId !== input.tenantId) {
      throw new ValidationFailedError({ patientId: ['Patient not found in this tenant.'] });
    }

    // Slice CM — typed method must come with a matching artifact ref,
    // and that ref must point at a valid, verified, same-tenant,
    // same-consent-type artifact row. The OTP was issued before the
    // patient row existed (intake flow), so patient binding happens
    // here: we backfill the OTP's patientId to the now-known id so
    // access-ledger queries can resolve "which OTPs touched patient X"
    // from either side of the join.
    //
    // Without this cross-check a malicious client could submit a
    // method='otp' grant with a forged ref and the consent ledger
    // would record a "verified OTP" that never actually happened.
    if (input.acknowledgementMethod === 'otp') {
      if (!input.acknowledgementRef) {
        throw new ValidationFailedError(
          { acknowledgementRef: ["acknowledgementRef is required when method='otp'."] },
        );
      }
      const otpRow = await tx.consentOtp.findUnique({
        where: { id: input.acknowledgementRef },
      });
      if (!otpRow || otpRow.tenantId !== input.tenantId) {
        throw new ValidationFailedError(
          { acknowledgementRef: ['OTP artifact not found in this tenant.'] },
        );
      }
      if (otpRow.status !== 'verified' || !otpRow.verifiedAt) {
        throw new ValidationFailedError(
          { acknowledgementRef: ['OTP must be verified before consent can be granted.'] },
        );
      }
      if (otpRow.consentType !== input.consentType) {
        throw new ValidationFailedError(
          { acknowledgementRef: ['OTP was issued for a different consent type.'] },
        );
      }
      // Backfill the patientId so the OTP row resolves to the
      // patient it ultimately authorised. No-op if a prior grant
      // path already linked it (idempotent under repeated submits).
      if (otpRow.patientId === null) {
        await tx.consentOtp.update({
          where: { id: otpRow.id },
          data: { patientId: input.patientId },
        });
      }
    }

    const row = await tx.consentRecord.create({
      data: {
        tenantId: input.tenantId,
        patientId: input.patientId,
        consentType: input.consentType,
        dataCategories: input.dataCategories,
        purposes: input.purposes,
        lawfulBasis: input.lawfulBasis,
        status: 'granted',
        source: input.source,
        evidence: input.evidence as unknown as object,
        expiresAt: input.expiresAt ?? null,
        capturedByUserId: input.actorUserId,
        documentId: input.documentId ?? null,
        // Slice CM — typed method + artifact ref. Application-layer
        // validation of the (method, ref) pair lives in the caller
        // (CaseService threads a verified OTP id; ConsentOtpController
        // ensures the OTP row is in 'verified' state).
        acknowledgementMethod: input.acknowledgementMethod ?? null,
        acknowledgementRef: input.acknowledgementRef ?? null,
      },
    });

    await this.audit.recordWithTx(tx, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      actorType: 'user',
      action: AuditEvents.CONSENT_GRANTED,
      resourceType: 'consent_record',
      resourceId: row.id,
      after: {
        patientId: input.patientId,
        consentType: input.consentType,
        purposes: input.purposes,
        lawfulBasis: input.lawfulBasis,
      },
    });

    return rowToShape(row);
  }

  // Flip status to withdrawn. Idempotent at the controller level
  // (status check rejects re-withdrawal); the audit row + reason
  // are required for DPDP §13 traceability.
  async withdraw(input: WithdrawConsentInput): Promise<ConsentRecordRow> {
    return this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      const existing = await tx.consentRecord.findUnique({ where: { id: input.consentId } });
      if (!existing || existing.tenantId !== input.tenantId) {
        throw new ValidationFailedError({ id: ['Consent record not found.'] });
      }
      if (existing.status !== 'granted') {
        throw new ValidationFailedError({
          status: [
            `Cannot withdraw from status='${existing.status}'. Only 'granted' consents can be withdrawn.`,
          ],
        });
      }
      const row = await tx.consentRecord.update({
        where: { id: input.consentId },
        data: {
          status: 'withdrawn',
          withdrawnAt: new Date(),
          withdrawalReason: input.reason,
        },
      });
      await this.audit.recordWithTx(tx, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        actorType: 'user',
        action: AuditEvents.CONSENT_WITHDRAWN,
        resourceType: 'consent_record',
        resourceId: row.id,
        after: {
          patientId: row.patientId,
          consentType: row.consentType,
          reason: input.reason,
        },
      });
      return rowToShape(row);
    });
  }

  async list(input: ListConsentsInput): Promise<{ rows: ConsentRecordRow[]; total: number }> {
    return this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      const where = {
        tenantId: input.tenantId,
        ...(input.patientId ? { patientId: input.patientId } : {}),
        ...(input.consentType ? { consentType: input.consentType } : {}),
        ...(input.status ? { status: input.status } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.consentRecord.findMany({
          where,
          orderBy: [{ grantedAt: 'desc' }, { id: 'desc' }],
          take: 200,
        }),
        tx.consentRecord.count({ where }),
      ]);
      return { rows: rows.map(rowToShape), total };
    });
  }

  async findById(tenantId: string, id: string): Promise<ConsentRecordRow | null> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const row = await tx.consentRecord.findUnique({ where: { id } });
      if (!row || row.tenantId !== tenantId) return null;
      return rowToShape(row);
    });
  }

  // Find the most-recent active grant for (tenant, patient, type).
  // "Active" means status='granted' AND (expiresAt is null OR
  // expiresAt > now). Returns null when no such row exists.
  // Service callers thread the returned id into
  // data_access_event.consentGrantId so the access is bound back
  // to the authorising grant.
  async findActiveFor(
    tenantId: string,
    patientId: string,
    consentType: string,
    now: Date = new Date(),
  ): Promise<ConsentRecordRow | null> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const row = await tx.consentRecord.findFirst({
        where: {
          tenantId,
          patientId,
          consentType,
          status: 'granted',
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        orderBy: { grantedAt: 'desc' },
      });
      return row ? rowToShape(row) : null;
    });
  }

  // Same query as findActiveFor inside an existing tenant tx — used
  // by service callers (PatientService, EligibilityService) that
  // already opened a transaction and want to bind the consent
  // lookup atomically with the read.
  async findActiveForWithTx(
    tx: TenantPrisma,
    tenantId: string,
    patientId: string,
    consentType: string,
    now: Date = new Date(),
  ): Promise<ConsentRecordRow | null> {
    const row = await tx.consentRecord.findFirst({
      where: {
        tenantId,
        patientId,
        consentType,
        status: 'granted',
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: { grantedAt: 'desc' },
    });
    return row ? rowToShape(row) : null;
  }

  // Throws ConsentNotGivenError-equivalent (ValidationFailedError
  // with the relevant code) when no active grant covers the
  // (patient, type) tuple. The error code surfaces to the
  // frontend so the operator-facing modal can prompt for a fresh
  // consent capture.
  async requireConsent(
    tenantId: string,
    patientId: string,
    consentType: ConsentType,
  ): Promise<ConsentRecordRow> {
    const row = await this.findActiveFor(tenantId, patientId, consentType);
    if (!row) {
      throw new ValidationFailedError(
        { consent: [`No active '${consentType}' consent for this patient.`] },
        `Active '${consentType}' consent required before processing.`,
      );
    }
    return row;
  }
}

function rowToShape(row: {
  id: string;
  tenantId: string;
  patientId: string;
  consentType: string;
  dataCategories: unknown;
  purposes: unknown;
  lawfulBasis: string;
  status: string;
  source: string;
  evidence: unknown;
  grantedAt: Date;
  expiresAt: Date | null;
  withdrawnAt: Date | null;
  withdrawalReason: string | null;
  capturedByUserId: string | null;
  documentId: string | null;
  acknowledgementMethod: string | null;
  acknowledgementRef: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ConsentRecordRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    patientId: row.patientId,
    consentType: row.consentType as ConsentType,
    dataCategories: (row.dataCategories as string[]) ?? [],
    purposes: (row.purposes as string[]) ?? [],
    lawfulBasis: row.lawfulBasis as LawfulBasis,
    status: row.status as ConsentStatus,
    source: row.source,
    evidence: row.evidence as ConsentEvidence,
    grantedAt: row.grantedAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
    withdrawalReason: row.withdrawalReason,
    capturedByUserId: row.capturedByUserId,
    documentId: row.documentId,
    acknowledgementMethod: row.acknowledgementMethod as AcknowledgementMethod | null,
    acknowledgementRef: row.acknowledgementRef,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
