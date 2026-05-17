// T2-13 follow-up — bill line item persistence.
//
// Replace-all save: each call to replaceForClaim() deletes the
// claim's existing line items and inserts the new set inside a
// single tenant transaction. We don't try to diff: the calculator
// UX is "paste the bill, save the bill" so a wholesale swap is the
// honest model. The audit_log row carries the new count + grand
// total so the trail is reconstructable even if the rows are
// later cleared.

import {
  type BillLineItem,
  type BillLineItemsListResponse,
  type NonMedicalCategory,
  type SaveBillLineItem,
} from '@claims/contracts';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditEvents, AuditService } from '../audit';

export interface ReplaceForClaimInput {
  tenantId: string;
  claimId: string;
  actorUserId: string;
  lines: SaveBillLineItem[];
  ip?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class BillLineItemService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async replaceForClaim(input: ReplaceForClaimInput): Promise<BillLineItemsListResponse> {
    const saved = await this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      // Delete then insert atomically. RLS gates both — cross-tenant
      // delete is silently a no-op (returns 0), insert is rejected
      // by the WITH CHECK policy.
      await tx.billLineItem.deleteMany({ where: { claimId: input.claimId } });

      if (input.lines.length > 0) {
        await tx.billLineItem.createMany({
          data: input.lines.map((line) => ({
            tenantId: input.tenantId,
            claimId: input.claimId,
            description: line.description,
            amountPaise: line.amountPaise,
            medical: line.medical,
            category: line.medical ? null : (line.category ?? null),
            matchedTerm: line.medical ? null : (line.matchedTerm ?? null),
            createdById: input.actorUserId,
          })),
        });
      }

      const after = await tx.billLineItem.findMany({
        where: { claimId: input.claimId },
        orderBy: { createdAt: 'asc' },
      });

      // Audit log: snapshot of what was saved. We don't store the
      // full row content (could be a long bill) — just count +
      // totals so the audit trail is bounded.
      const grandTotal = after.reduce((acc, l) => acc + l.amountPaise, 0);
      const nonMedical = after.filter((l) => !l.medical).reduce((acc, l) => acc + l.amountPaise, 0);
      await this.audit.recordWithTx(tx, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        actorType: 'user',
        action: AuditEvents.TENANT_UPDATED,
        resourceType: 'bill_line_item',
        resourceId: input.claimId,
        after: {
          lineCount: after.length,
          grandTotalPaise: grandTotal,
          nonMedicalPaise: nonMedical,
        },
        ipAddress: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      });

      return after;
    });

    return this.toListResponse(saved);
  }

  async listForClaim(
    tenantId: string,
    claimId: string,
  ): Promise<BillLineItemsListResponse> {
    const rows = await this.prisma.runInTenantContext(tenantId, 'tenant', (tx) =>
      tx.billLineItem.findMany({
        where: { claimId },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return this.toListResponse(rows);
  }

  private toListResponse(
    rows: Array<{
      id: string;
      description: string;
      amountPaise: number;
      medical: boolean;
      category: string | null;
      matchedTerm: string | null;
      createdAt: Date;
    }>,
  ): BillLineItemsListResponse {
    let medicalPaise = 0;
    let nonMedicalPaise = 0;
    const lines: BillLineItem[] = rows.map((r) => {
      if (r.medical) {
        medicalPaise += r.amountPaise;
      } else {
        nonMedicalPaise += r.amountPaise;
      }
      return {
        id: r.id,
        description: r.description,
        amountPaise: r.amountPaise,
        medical: r.medical,
        category: r.medical ? null : ((r.category as NonMedicalCategory | null) ?? null),
        matchedTerm: r.medical ? null : r.matchedTerm,
        createdAt: r.createdAt.toISOString(),
      };
    });
    return {
      lines,
      totals: {
        medicalPaise,
        nonMedicalPaise,
        grandTotalPaise: medicalPaise + nonMedicalPaise,
      },
    };
  }
}
