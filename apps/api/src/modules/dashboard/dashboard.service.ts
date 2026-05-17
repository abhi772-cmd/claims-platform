// Operational dashboard service — read-side aggregation for the
// dashboard landing page tiles. Tenant-scoped via RLS; no writes.
//
// Strategy: one pass over open claims (with their events for SLA
// computation) plus a few cheap counts. We deliberately don't
// pre-aggregate via groupBy because (a) tenant scale is small
// (low hundreds of open claims is the norm) and (b) the SLA at-
// risk count requires per-claim event replay anyway, so we may as
// well bucket the status counts in the same pass.

import { type OperationalDashboardResponse } from '@claims/contracts';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';
import { computeSlaForClaim, type SlaEvent } from '../claim/sla-deadline';

const DRAFTING_STATUSES = new Set<string>([
  'ELIGIBILITY_PENDING',
  'ELIGIBILITY_VERIFIED',
  'ELIGIBILITY_FAILED',
  'PREAUTH_DRAFTING',
  'CLAIM_DRAFTING',
  'DISCHARGE_PENDING',
]);

const AWAITING_PAYER_STATUSES = new Set<string>([
  'PREAUTH_QUEUED',
  'PREAUTH_SUBMITTED',
  'PREAUTH_QUERY_RAISED',
  'PREAUTH_QUERY_RESPONDED',
  'ENHANCEMENT_QUEUED',
  'ENHANCEMENT_SUBMITTED',
  'CLAIM_QUEUED',
  'CLAIM_SUBMITTED',
  'CLAIM_QUERY_RAISED',
  'CLAIM_QUERY_RESPONDED',
  'DISCHARGE_SUBMITTED',
]);

const APPROVED_STATUSES = new Set<string>([
  'PREAUTH_APPROVED',
  'PREAUTH_PARTIALLY_APPROVED',
  'ENHANCEMENT_APPROVED',
  'CLAIM_APPROVED',
  'CLAIM_PARTIALLY_APPROVED',
]);

const PAYMENT_PENDING_STATUSES = new Set<string>([
  'PAYMENT_PENDING',
  'PAYMENT_RECEIVED',
  'SHORT_PAID',
]);

const PENDING_APPEAL_STATUSES = ['APPEAL_INITIATED', 'APPEAL_SUBMITTED'];

// Open-claim umbrella: every status that lives BEFORE the claim
// reaches a terminal closed state. We don't include APPEAL_*
// here because appeals get their own tile + are typically a
// re-opened workflow on top of an already-closed claim.
function isOpenClaimStatus(status: string): boolean {
  return (
    DRAFTING_STATUSES.has(status) ||
    AWAITING_PAYER_STATUSES.has(status) ||
    APPROVED_STATUSES.has(status) ||
    PAYMENT_PENDING_STATUSES.has(status)
  );
}

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async operational(tenantId: string): Promise<OperationalDashboardResponse> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const now = new Date();
      const today = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );

      // Single pass over open claims with their events — feeds
      // BOTH the open-claim phase buckets AND the SLA at-risk
      // count, so we don't double-scan.
      const openClaims = await tx.claim.findMany({
        where: {
          tenantId,
          status: { in: Array.from(new Set([
            ...DRAFTING_STATUSES,
            ...AWAITING_PAYER_STATUSES,
            ...APPROVED_STATUSES,
            ...PAYMENT_PENDING_STATUSES,
          ])) },
        },
        select: {
          status: true,
          events: {
            orderBy: { occurredAt: 'asc' },
            select: { eventType: true, occurredAt: true },
          },
        },
      });

      let drafting = 0;
      let awaitingPayer = 0;
      let approved = 0;
      let paymentPending = 0;
      let slaBreached = 0;
      let slaExpiringSoon = 0;

      for (const c of openClaims) {
        if (!isOpenClaimStatus(c.status)) continue;
        if (DRAFTING_STATUSES.has(c.status)) drafting += 1;
        else if (AWAITING_PAYER_STATUSES.has(c.status)) awaitingPayer += 1;
        else if (APPROVED_STATUSES.has(c.status)) approved += 1;
        else if (PAYMENT_PENDING_STATUSES.has(c.status)) paymentPending += 1;

        // SLA is computed from the event stream. A claim can have
        // two phases (preauth + claim); count both phases that are
        // currently at-risk / breached. A claim that's breached on
        // BOTH phases shows up as 2 in the tally, which is the
        // honest count of regulatory exposure.
        const sla = computeSlaForClaim(
          c.events.map(
            (e): SlaEvent => ({
              eventType: e.eventType as SlaEvent['eventType'],
              occurredAt: e.occurredAt,
            }),
          ),
          now,
        );
        for (const phase of [sla.preauth, sla.claim]) {
          if (phase === null) continue;
          if (phase.status === 'breached') slaBreached += 1;
          else if (phase.status === 'at_risk') slaExpiringSoon += 1;
        }
      }

      // Pending appeals — claims sitting in an active appeal state.
      const pendingAppeals = await tx.claim.count({
        where: { tenantId, status: { in: PENDING_APPEAL_STATUSES } },
      });

      // Discharges due today — cases whose admission + estimated
      // stay length lands within today ±1 day, AND whose claim is
      // still in the "approved but not yet discharged" window.
      // Computed in TS because Prisma can't express the
      // "admissionDate + estimatedStayDays column-arithmetic"
      // filter cleanly; load candidates, filter in memory.
      const candidates = await tx.case.findMany({
        where: {
          tenantId,
          caseStatus: 'open',
          estimatedStayDays: { not: null },
          claims: {
            some: {
              status: {
                in: [
                  'PREAUTH_APPROVED',
                  'PREAUTH_PARTIALLY_APPROVED',
                  'ENHANCEMENT_APPROVED',
                  'DISCHARGE_PENDING',
                ],
              },
            },
          },
        },
        select: { admissionDate: true, estimatedStayDays: true },
      });
      const todayMs = today.getTime();
      const oneDayMs = 24 * 60 * 60 * 1000;
      let dischargesDueToday = 0;
      for (const c of candidates) {
        if (c.estimatedStayDays === null) continue;
        const admissionMs = c.admissionDate.getTime();
        const expectedDischargeMs = admissionMs + c.estimatedStayDays * oneDayMs;
        // Within ±1 day of today — captures "today, tomorrow,
        // yesterday but not yet processed." Operators care about
        // imminent discharges, not exact-today.
        if (Math.abs(expectedDischargeMs - todayMs) <= oneDayMs) {
          dischargesDueToday += 1;
        }
      }

      return {
        openClaims: {
          total: drafting + awaitingPayer + approved + paymentPending,
          drafting,
          awaitingPayer,
          approved,
          paymentPending,
        },
        slaAtRisk: {
          breached: slaBreached,
          expiringSoon: slaExpiringSoon,
        },
        dischargesDueToday,
        pendingAppeals,
        generatedAt: now.toISOString(),
      };
    });
  }
}
