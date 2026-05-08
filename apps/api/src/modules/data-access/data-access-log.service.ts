// Slice BR — DPDP §17 data access ledger writer.
//
// Two write paths mirror AuditService for symmetry:
//   - record()          — opens a dedicated platform_admin tx; use
//                         for system-driven access (NHCX inbound,
//                         retention sweeper) where there's no
//                         pre-existing tenant context.
//   - recordWithTx(tx)  — writes inside an existing tenant tx; use
//                         from request-scoped service code so the
//                         access row commits atomically with the
//                         operation that touched the data.
//
// Read path (listForTenant) is reserved for BU's compliance
// dashboard and intentionally omitted here — keep BR focused on
// recording.

import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';
import { type TenantPrisma } from '../../types/express';

export interface DataAccessWriteInput {
  tenantId: string;
  actorUserId?: string | null;
  actorType: 'user' | 'system' | 'scheduled';
  // 'patient' | 'case' | 'audit_log' | 'erasure_request' | 'data_access_event' | etc.
  resourceType: string;
  resourceId?: string | null;
  // 'decrypt' | 'list' | 'view' | 'export'
  action: 'decrypt' | 'list' | 'view' | 'export';
  // Why the read happened. Conventional values:
  // 'eligibility.verify' | 'preauth.submit' | 'preauth.cancel' |
  // 'claim.submit' | 'claim.reprocess' | 'manual_view' |
  // 'audit_query' | 'audit_export' | 'erasure_check' | 'unspecified'.
  // Keep this short + greppable; the dashboard groups on it.
  purpose: string;
  // List of sensitive field names that were touched. Only set when
  // the access actually decrypted or surfaced specific fields —
  // most reads of unencrypted PII (Case.patientName, audit-log
  // entries) leave this null.
  fieldNames?: string[] | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
  // Slice BT — id of the ConsentRecord that authorised this access.
  // Optional because (1) callers wired before BT shipped land null
  // and (2) some reads happen under a non-consent lawful basis
  // (legal_obligation / public_interest) that doesn't bind to a
  // specific consent grant. BU's dashboard groups by this column
  // to answer "show every read authorised by this grant".
  consentGrantId?: string | null;
}

@Injectable()
export class DataAccessLogService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: DataAccessWriteInput): Promise<void> {
    await this.prisma.runInTenantContext(input.tenantId, 'platform_admin', async (tx) => {
      await this.recordWithTx(tx, input);
    });
  }

  async recordWithTx(tx: TenantPrisma, input: DataAccessWriteInput): Promise<void> {
    await tx.dataAccessEvent.create({
      data: {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId ?? null,
        actorType: input.actorType,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        action: input.action,
        purpose: input.purpose,
        fieldNames: (input.fieldNames ?? null) as never,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        correlationId: input.correlationId ?? null,
        consentGrantId: input.consentGrantId ?? null,
      },
    });
  }
}
