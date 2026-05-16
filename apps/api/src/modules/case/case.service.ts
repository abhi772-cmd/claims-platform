import {
  type CaseDetail,
  type CaseSummary,
  type ClaimRail,
  type ClaimSla,
  type ClaimStatus,
  type CreateCaseRequest,
  type ListCasesResponse,
  type UpdateCaseRequest,
} from '@claims/contracts';
import { Injectable } from '@nestjs/common';

import { CaseNotFoundError } from '../../common/errors/case-errors';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditEvents, AuditService } from '../audit';
import { ClaimService } from '../claim';
import { computeSlaForClaim, type SlaEvent } from '../claim/sla-deadline';
import { ConsentService } from '../consent/consent.module';
import { PatientService } from '../patient';

export interface CreateCaseInput extends CreateCaseRequest {
  tenantId: string;
  actorUserId: string;
  ip: string | null;
  userAgent: string | null;
}

export interface UpdateCaseInput extends UpdateCaseRequest {
  tenantId: string;
  caseId: string;
  actorUserId: string;
  ip: string | null;
  userAgent: string | null;
}

export interface ListCasesInput {
  tenantId: string;
  limit: number;
  offset: number;
  status?: 'open' | 'closed' | 'abandoned';
}

@Injectable()
export class CaseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly claims: ClaimService,
    private readonly patients: PatientService,
    private readonly consents: ConsentService,
  ) {}

  // Create a Case AND mint the first Claim. The two are atomic via the
  // outer tenant tx; if claim creation fails (e.g. caseId FK race), the
  // case row is rolled back too.
  async create(input: CreateCaseInput): Promise<CaseDetail> {
    const created = await this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      // If PII was provided, create the encrypted Patient row first
      // inside the same tx so a Case never points at a non-existent
      // Patient. The Patient row is rolled back if Case creation fails.
      let patientId: string | null = null;
      if (input.patient) {
        const created = await this.patients.createWithTx(tx, input.tenantId, {
          fullName: input.patientName,
          ...(input.patient.dateOfBirth !== undefined
            ? { dateOfBirth: input.patient.dateOfBirth }
            : {}),
          ...(input.patient.gender !== undefined ? { gender: input.patient.gender } : {}),
          ...(input.patient.aadhaar !== undefined ? { aadhaar: input.patient.aadhaar } : {}),
          ...(input.patient.abhaId !== undefined ? { abhaId: input.patient.abhaId } : {}),
          ...(input.patient.policyNumber !== undefined
            ? { policyNumber: input.patient.policyNumber }
            : {}),
          ...(input.patient.mobile !== undefined ? { mobile: input.patient.mobile } : {}),
          ...(input.patient.email !== undefined ? { email: input.patient.email } : {}),
        });
        patientId = created.id;
      }

      // Slice CF — consent capture must come with a patient row. A
      // consent grant binds back to a patientId; if PII wasn't
      // supplied we have no row to bind to.
      if (input.consent && patientId === null) {
        throw new ValidationFailedError({
          consent: ['Consent capture requires patient PII to be supplied alongside.'],
        });
      }

      const c = await tx.case.create({
        data: {
          tenantId: input.tenantId,
          ...(patientId !== null ? { patientId } : {}),
          patientName: input.patientName,
          hospitalMrn: input.hospitalMrn,
          admissionDate: new Date(input.admissionDate),
          admissionType: input.admissionType,
          primaryRail: input.primaryRail,
          ...(input.treatingDoctorId !== undefined
            ? { treatingDoctorId: input.treatingDoctorId }
            : {}),
          // T2-14 — room rent pre-warn fields captured at intake.
          ...(input.roomDailyRate !== undefined
            ? { roomDailyRate: input.roomDailyRate }
            : {}),
          ...(input.policyRoomRentLimit !== undefined
            ? { policyRoomRentLimit: input.policyRoomRentLimit }
            : {}),
          ...(input.estimatedStayDays !== undefined
            ? { estimatedStayDays: input.estimatedStayDays }
            : {}),
          createdById: input.actorUserId,
        },
      });

      // Slice CF — grant consent inside the same tx so case +
      // patient + consent commit atomically. The grant emits its
      // own CONSENT_GRANTED audit row, distinct from the case-
      // create audit row above.
      if (input.consent && patientId !== null) {
        await this.consents.grantWithTx(tx, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          patientId,
          consentType: input.consent.consentType,
          dataCategories: input.consent.dataCategories,
          purposes: input.consent.purposes,
          lawfulBasis: input.consent.lawfulBasis,
          source: input.consent.source,
          evidence: input.consent.evidence,
          ...(input.consent.expiresAt !== undefined
            ? { expiresAt: new Date(input.consent.expiresAt) }
            : {}),
        });
      }
      // Audit record carries DISPLAY-safe fields only — no encrypted
      // identifiers in the audit_log payload (those would otherwise be
      // permanently exposed in plaintext snapshots).
      await this.audit.recordWithTx(tx, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        actorType: 'user',
        action: AuditEvents.TENANT_UPDATED, // generic create-resource event for now
        resourceType: 'case',
        resourceId: c.id,
        after: {
          patientName: input.patientName,
          hospitalMrn: input.hospitalMrn,
          primaryRail: input.primaryRail,
          ...(patientId !== null ? { patientId } : {}),
        },
        ipAddress: input.ip,
        userAgent: input.userAgent,
      });
      return c;
    });

    // ClaimService.create opens its own tenant tx — idempotent; if it
    // fails we'd need to clean up the case row. For Sprint 2 we accept
    // that two consecutive failures are unlikely and Sprint 3 can wrap
    // them in a single outer tx. The tradeoff: ClaimService is meant
    // to be callable independently, and we don't want to leak its
    // tx context outwards.
    const claim = await this.claims.create({
      tenantId: input.tenantId,
      caseId: created.id,
      rail: input.primaryRail,
      actorUserId: input.actorUserId,
    });

    return this.assemble(created, [
      {
        id: claim.id,
        tenantId: claim.tenantId,
        caseId: claim.caseId,
        rail: claim.rail,
        status: claim.status,
        preauthAmount: claim.preauthAmount,
        approvedAmount: claim.approvedAmount,
        paidAmount: claim.paidAmount,
        payerRefNum: claim.payerRefNum,
        preauthRefNum: claim.preauthRefNum,
        claimRefNum: claim.claimRefNum,
        initiatedAt: claim.initiatedAt.toISOString(),
        closedAt: claim.closedAt ? claim.closedAt.toISOString() : null,
      },
    ]);
  }

  async list(input: ListCasesInput): Promise<ListCasesResponse> {
    return this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      const where = {
        tenantId: input.tenantId,
        ...(input.status ? { caseStatus: input.status } : {}),
      } as const;
      const [rows, total] = await Promise.all([
        tx.case.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: input.offset,
          take: input.limit,
          include: {
            claims: {
              orderBy: { initiatedAt: 'desc' },
              take: 1,
              select: {
                status: true,
                // T2-15 follow-up — load the events for the headline
                // claim so we can compute IRDAI SLA state and surface
                // pre-auth + claim pills on the list cards.
                events: {
                  orderBy: { occurredAt: 'asc' },
                  select: { eventType: true, occurredAt: true },
                },
              },
            },
          },
        }),
        tx.case.count({ where }),
      ]);
      const now = new Date();
      return {
        cases: rows.map((r) => {
          const headline = r.claims[0];
          const sla = headline
            ? computeSlaForClaim(
                headline.events.map(
                  (e): SlaEvent => ({
                    eventType: e.eventType as SlaEvent['eventType'],
                    occurredAt: e.occurredAt,
                  }),
                ),
                now,
              )
            : null;
          return this.toSummary(r, headline?.status ?? null, sla);
        }),
        total,
        limit: input.limit,
        offset: input.offset,
      };
    });
  }

  async getById(tenantId: string, caseId: string): Promise<CaseDetail> {
    const row = await this.prisma.runInTenantContext(tenantId, 'tenant', (tx) =>
      tx.case.findUnique({
        where: { id: caseId },
        include: {
          claims: {
            orderBy: { initiatedAt: 'asc' },
            // T2-15 — pull events so we can compute the IRDAI SLA state
            // (1-hour preauth, 3-hour claim) at read time without a
            // second round-trip per claim.
            include: {
              events: {
                orderBy: { occurredAt: 'asc' },
                select: { eventType: true, occurredAt: true },
              },
            },
          },
        },
      }),
    );
    if (!row) throw new CaseNotFoundError();
    const now = new Date();
    const claims = row.claims.map((c) => ({
      id: c.id,
      tenantId: c.tenantId,
      caseId: c.caseId,
      rail: c.rail as ClaimRail,
      status: c.status as ClaimStatus,
      preauthAmount: c.preauthAmount,
      approvedAmount: c.approvedAmount,
      paidAmount: c.paidAmount,
      payerRefNum: c.payerRefNum,
      preauthRefNum: c.preauthRefNum,
      claimRefNum: c.claimRefNum,
      initiatedAt: c.initiatedAt.toISOString(),
      closedAt: c.closedAt ? c.closedAt.toISOString() : null,
      sla: computeSlaForClaim(
        c.events.map(
          (e): SlaEvent => ({
            eventType: e.eventType as SlaEvent['eventType'],
            occurredAt: e.occurredAt,
          }),
        ),
        now,
      ),
    }));
    return this.assemble(row, claims);
  }

  async update(input: UpdateCaseInput): Promise<CaseDetail> {
    const updated = await this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      const before = await tx.case.findUnique({ where: { id: input.caseId } });
      if (!before) throw new CaseNotFoundError();
      const data: Record<string, unknown> = {};
      if (input.caseStatus !== undefined) {
        data['caseStatus'] = input.caseStatus;
        if (input.caseStatus === 'closed' || input.caseStatus === 'abandoned') {
          data['closedAt'] = new Date();
        }
      }
      if (input.treatingDoctorId !== undefined) {
        data['treatingDoctorId'] = input.treatingDoctorId;
      }
      // T2-8 — operator updates current room rate (paise) when the
      // patient is moved to a higher-tier ward. The audit_log row
      // below carries the before/after so the trail shows the
      // ward-transfer history without us adding a new audit type.
      if (input.currentRoomDailyRate !== undefined) {
        data['currentRoomDailyRate'] = input.currentRoomDailyRate;
      }
      const after = await tx.case.update({
        where: { id: input.caseId },
        data,
      });
      await this.audit.recordWithTx(tx, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        actorType: 'user',
        action: AuditEvents.TENANT_UPDATED,
        resourceType: 'case',
        resourceId: input.caseId,
        before: {
          caseStatus: before.caseStatus,
          treatingDoctorId: before.treatingDoctorId,
          currentRoomDailyRate: before.currentRoomDailyRate,
        },
        after: data,
        ipAddress: input.ip,
        userAgent: input.userAgent,
      });
      return after;
    });
    return this.getById(input.tenantId, updated.id);
  }

  private toSummary(
    c: {
      id: string;
      patientName: string;
      hospitalMrn: string;
      admissionDate: Date;
      admissionType: string;
      primaryRail: string;
      caseStatus: string;
      treatingDoctorId: string | null;
      createdAt: Date;
      closedAt: Date | null;
      roomDailyRate: number | null;
      policyRoomRentLimit: number | null;
      estimatedStayDays: number | null;
      currentRoomDailyRate: number | null;
    },
    headlineStatus: string | null,
    sla: ClaimSla | null = null,
  ): CaseSummary {
    return {
      id: c.id,
      patientName: c.patientName,
      hospitalMrn: c.hospitalMrn,
      admissionDate: c.admissionDate.toISOString().slice(0, 10),
      admissionType: c.admissionType as CaseSummary['admissionType'],
      primaryRail: c.primaryRail as ClaimRail,
      caseStatus: c.caseStatus as CaseSummary['caseStatus'],
      treatingDoctorId: c.treatingDoctorId,
      createdAt: c.createdAt.toISOString(),
      closedAt: c.closedAt ? c.closedAt.toISOString() : null,
      headlineClaimStatus: (headlineStatus as ClaimStatus | null) ?? null,
      // Only attach when at least one phase has timer data — keeps the
      // wire footprint small for cases that haven't reached preauth /
      // claim submit yet, and matches how the schema marks sla as
      // optional rather than always-present.
      ...(sla && (sla.preauth || sla.claim) ? { sla } : {}),
      // T2-14 — pass through whatever the operator captured at intake.
      // Always present (nullable) so client can distinguish
      // "captured & zero" from "not captured".
      roomDailyRate: c.roomDailyRate,
      policyRoomRentLimit: c.policyRoomRentLimit,
      estimatedStayDays: c.estimatedStayDays,
      // T2-8 — current room rate (operator-updated). When > roomDailyRate
      // the case-detail page auto-suggests a preauth enhancement.
      currentRoomDailyRate: c.currentRoomDailyRate,
    };
  }

  private assemble(
    row: {
      id: string;
      patientName: string;
      hospitalMrn: string;
      admissionDate: Date;
      admissionType: string;
      primaryRail: string;
      caseStatus: string;
      treatingDoctorId: string | null;
      createdAt: Date;
      closedAt: Date | null;
      roomDailyRate: number | null;
      policyRoomRentLimit: number | null;
      estimatedStayDays: number | null;
      currentRoomDailyRate: number | null;
    },
    claims: CaseDetail['claims'],
  ): CaseDetail {
    const headlineStatus = claims[claims.length - 1]?.status ?? null;
    return { ...this.toSummary(row, headlineStatus), claims };
  }
}
