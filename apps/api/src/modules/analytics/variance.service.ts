// T3-1 — CFO variance dashboard service.
//
// Three independent read aggregations over Claim + Case rows. All
// queries are tenant-scoped via RLS context (PrismaService.runInTenantContext).
// No state mutations and no new tables.
//
// "Adjudicated" claims = those past the adjudication gate. We use a
// concrete status whitelist rather than "status >= APPROVED" because
// the state-machine doesn't impose an ordering on enum values.

import {
  type VarianceAgingBucket,
  type VarianceAgingRow,
  type VarianceByPayerResponse,
  type VarianceClaimRow,
  type VarianceClaimsResponse,
  type VariancePayerRow,
  type VarianceSummaryResponse,
} from '@claims/contracts';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';

// Statuses where claim.claimAmount + approvedAmount are both
// expected to be populated (i.e. the variance numbers mean
// something). Pre-claim-submit statuses are excluded — billed/
// approved aren't materialised yet.
const ADJUDICATED_STATUSES = [
  'CLAIM_APPROVED',
  'CLAIM_PARTIALLY_APPROVED',
  'CLAIM_REJECTED',
  'PAYMENT_PENDING',
  'PAYMENT_RECEIVED',
  'PAYMENT_SHORT_PAID',
  'PAYMENT_RECONCILED',
  'CLAIM_CLOSED',
  'CLAIM_WRITTEN_OFF',
];

// Statuses where the claim is still awaiting bank payout (drives the
// aging-bucket calculation).
const UNSETTLED_STATUSES = [
  'PAYMENT_PENDING',
  'PAYMENT_RECEIVED', // received but not yet reconciled
  'PAYMENT_SHORT_PAID',
];

function bucketFor(daysOld: number): VarianceAgingBucket {
  if (daysOld <= 7) return 'd0_7';
  if (daysOld <= 14) return 'd8_14';
  if (daysOld <= 30) return 'd15_30';
  return 'd31_plus';
}

@Injectable()
export class VarianceService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(tenantId: string): Promise<VarianceSummaryResponse> {
    const now = new Date();
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const adjudicated = await tx.claim.findMany({
        where: { tenantId, status: { in: ADJUDICATED_STATUSES } },
        select: {
          claimAmount: true,
          approvedAmount: true,
          paidAmount: true,
        },
      });
      const unsettled = await tx.claim.findMany({
        where: { tenantId, status: { in: UNSETTLED_STATUSES } },
        select: {
          submittedAt: true,
          approvedAmount: true,
        },
      });

      let totalBilled = 0;
      let totalApproved = 0;
      let totalPaid = 0;
      let totalBilledVariance = 0;
      let totalShortPay = 0;
      let contributingClaimCount = 0;
      for (const c of adjudicated) {
        const billed = c.claimAmount ?? 0;
        const approved = c.approvedAmount ?? 0;
        const paid = c.paidAmount ?? 0;
        totalBilled += billed;
        totalApproved += approved;
        totalPaid += paid;
        // Only count rows where both amounts are known toward the
        // variance figure — counting against zero would over-state.
        if (c.claimAmount !== null && c.approvedAmount !== null) {
          totalBilledVariance += billed - approved;
          contributingClaimCount += 1;
        }
        if (
          c.approvedAmount !== null &&
          c.paidAmount !== null &&
          paid < approved
        ) {
          totalShortPay += approved - paid;
        }
      }

      // Aging buckets — for unsettled claims, days from submittedAt
      // to now. submittedAt is set when the claim hits CLAIM_QUEUED
      // (see ClaimService.transition's patch.submittedAt path).
      const agingMap = new Map<VarianceAgingBucket, { count: number; outstanding: number }>();
      for (const c of unsettled) {
        if (!c.submittedAt) continue;
        const days = Math.max(
          0,
          Math.floor((now.getTime() - c.submittedAt.getTime()) / (1000 * 60 * 60 * 24)),
        );
        const bucket = bucketFor(days);
        const slot = agingMap.get(bucket) ?? { count: 0, outstanding: 0 };
        slot.count += 1;
        slot.outstanding += c.approvedAmount ?? 0;
        agingMap.set(bucket, slot);
      }
      // Preserve a stable order in the output (d0_7 → d31_plus).
      const order: VarianceAgingBucket[] = ['d0_7', 'd8_14', 'd15_30', 'd31_plus'];
      const aging: VarianceAgingRow[] = [];
      for (const bucket of order) {
        const slot = agingMap.get(bucket);
        if (!slot || slot.count === 0) continue;
        aging.push({
          bucket,
          count: slot.count,
          outstandingAmount: slot.outstanding,
        });
      }

      return {
        totalBilled,
        totalApproved,
        totalPaid,
        totalBilledVariance,
        totalShortPay,
        totalNetLeakage: totalBilledVariance + totalShortPay,
        contributingClaimCount,
        aging,
        reportedAt: now.toISOString(),
      };
    });
  }

  async byPayer(tenantId: string, limit = 10): Promise<VarianceByPayerResponse> {
    const capped = Math.min(Math.max(limit, 1), 50);
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const claims = await tx.claim.findMany({
        where: { tenantId, status: { in: ADJUDICATED_STATUSES } },
        select: {
          payerCode: true,
          claimAmount: true,
          approvedAmount: true,
          paidAmount: true,
        },
      });
      // Group by payerCode in-process — payer counts are typically
      // tens at most per tenant, so this is cheap. Doing it in SQL
      // would require Prisma's groupBy + a separate count query, and
      // the in-process loop keeps the variance math in one place.
      const byPayer = new Map<
        string,
        {
          claimCount: number;
          totalBilled: number;
          totalApproved: number;
          totalPaid: number;
        }
      >();
      for (const c of claims) {
        const key = c.payerCode ?? '__unassigned__';
        const slot = byPayer.get(key) ?? {
          claimCount: 0,
          totalBilled: 0,
          totalApproved: 0,
          totalPaid: 0,
        };
        slot.claimCount += 1;
        slot.totalBilled += c.claimAmount ?? 0;
        slot.totalApproved += c.approvedAmount ?? 0;
        slot.totalPaid += c.paidAmount ?? 0;
        byPayer.set(key, slot);
      }
      const rows: VariancePayerRow[] = Array.from(byPayer.entries()).map(
        ([payerCode, s]) => {
          const billedVariance = s.totalBilled - s.totalApproved;
          const shortPay = Math.max(0, s.totalApproved - s.totalPaid);
          return {
            payerCode,
            claimCount: s.claimCount,
            totalBilled: s.totalBilled,
            totalApproved: s.totalApproved,
            totalPaid: s.totalPaid,
            billedVariance,
            shortPay,
            netLeakage: billedVariance + shortPay,
            varianceRate: s.totalBilled > 0 ? billedVariance / s.totalBilled : 0,
          };
        },
      );
      rows.sort((a, b) => b.netLeakage - a.netLeakage);
      return { rows: rows.slice(0, capped) };
    });
  }

  async claims(
    tenantId: string,
    filter: {
      bucket?: VarianceAgingBucket;
      payerCode?: string;
      limit?: number;
    },
  ): Promise<VarianceClaimsResponse> {
    const capped = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const now = new Date();

    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      // We can't filter by aging bucket directly in the DB (it's a
      // computed range), but every other filter is column-level.
      const whereStatus = filter.bucket
        ? { in: UNSETTLED_STATUSES }
        : { in: ADJUDICATED_STATUSES };
      const claims = await tx.claim.findMany({
        where: {
          tenantId,
          status: whereStatus,
          ...(filter.payerCode ? { payerCode: filter.payerCode } : {}),
        },
        select: {
          id: true,
          caseId: true,
          status: true,
          payerCode: true,
          claimAmount: true,
          approvedAmount: true,
          paidAmount: true,
          claimRefNum: true,
          submittedAt: true,
        },
        orderBy: { submittedAt: 'desc' },
        // Pull a generous slice and filter the aging bucket in
        // memory; for tenants approaching the cap of 200, the
        // post-filter still fits comfortably.
        take: filter.bucket ? Math.min(capped * 4, 800) : capped,
      });
      const caseIds = Array.from(new Set(claims.map((c) => c.caseId)));
      const cases = await tx.case.findMany({
        where: { id: { in: caseIds } },
        select: { id: true, patientName: true },
      });
      const caseById = new Map(cases.map((c) => [c.id, c]));

      const rows: VarianceClaimRow[] = [];
      for (const c of claims) {
        const days =
          c.submittedAt !== null
            ? Math.max(
                0,
                Math.floor(
                  (now.getTime() - c.submittedAt.getTime()) /
                    (1000 * 60 * 60 * 24),
                ),
              )
            : null;
        if (filter.bucket && (days === null || bucketFor(days) !== filter.bucket)) {
          continue;
        }
        rows.push({
          claimId: c.id,
          caseId: c.caseId,
          patientName: caseById.get(c.caseId)?.patientName ?? '',
          payerCode: c.payerCode,
          status: c.status,
          claimRefNum: c.claimRefNum,
          claimAmount: c.claimAmount,
          approvedAmount: c.approvedAmount,
          paidAmount: c.paidAmount,
          billedVariance:
            c.claimAmount !== null && c.approvedAmount !== null
              ? c.claimAmount - c.approvedAmount
              : null,
          shortPay:
            c.approvedAmount !== null && c.paidAmount !== null
              ? Math.max(0, c.approvedAmount - c.paidAmount)
              : null,
          agingDays: days,
          submittedAt: c.submittedAt?.toISOString() ?? null,
        });
        if (rows.length >= capped) break;
      }
      return { rows, total: rows.length };
    });
  }
}
