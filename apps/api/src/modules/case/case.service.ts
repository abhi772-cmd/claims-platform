import {
  type CaseDetail,
  type CaseSummary,
  type ClaimRail,
  type ClaimStatus,
  type CreateCaseRequest,
  type ListCasesResponse,
  type UpdateCaseRequest,
} from '@claims/contracts';
import { Injectable } from '@nestjs/common';

import { CaseNotFoundError } from '../../common/errors/case-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditEvents, AuditService } from '../audit';
import { ClaimService } from '../claim';

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
  ) {}

  // Create a Case AND mint the first Claim. The two are atomic via the
  // outer tenant tx; if claim creation fails (e.g. caseId FK race), the
  // case row is rolled back too.
  async create(input: CreateCaseInput): Promise<CaseDetail> {
    const created = await this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      const c = await tx.case.create({
        data: {
          tenantId: input.tenantId,
          patientName: input.patientName,
          hospitalMrn: input.hospitalMrn,
          admissionDate: new Date(input.admissionDate),
          admissionType: input.admissionType,
          primaryRail: input.primaryRail,
          ...(input.treatingDoctorId !== undefined
            ? { treatingDoctorId: input.treatingDoctorId }
            : {}),
          createdById: input.actorUserId,
        },
      });
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
              select: { status: true },
            },
          },
        }),
        tx.case.count({ where }),
      ]);
      return {
        cases: rows.map((r) => this.toSummary(r, r.claims[0]?.status ?? null)),
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
        include: { claims: { orderBy: { initiatedAt: 'asc' } } },
      }),
    );
    if (!row) throw new CaseNotFoundError();
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
        before: { caseStatus: before.caseStatus, treatingDoctorId: before.treatingDoctorId },
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
    },
    headlineStatus: string | null,
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
    },
    claims: CaseDetail['claims'],
  ): CaseDetail {
    const headlineStatus = claims[claims.length - 1]?.status ?? null;
    return { ...this.toSummary(row, headlineStatus), claims };
  }
}
