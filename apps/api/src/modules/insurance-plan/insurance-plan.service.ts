// Insurance plan read-side projection.
//
// Composes the case row + the headline claim + the latest
// `eligibility.verified` ClaimEvent into a single payload the
// case-detail page renders as the operator-facing plan card.
// Read-only — no persistence. Tenant-scoped via RLS context.

import {
  type EligibilityVerificationStatus,
  type InsurancePlanResponse,
} from '@claims/contracts';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';

interface EligibilityEventPayload {
  planName?: string;
  sumInsured?: number;
  failureReason?: string;
}

function isEligibilityPayload(v: unknown): v is EligibilityEventPayload {
  return typeof v === 'object' && v !== null;
}

@Injectable()
export class InsurancePlanService {
  constructor(private readonly prisma: PrismaService) {}

  async getForClaim(
    tenantId: string,
    caseId: string,
    claimId: string,
  ): Promise<InsurancePlanResponse> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      // Three reads in parallel — case row for room-rent limit,
      // claim row for approved-to-date, latest eligibility event
      // for the plan-name / sum-insured / failure-reason.
      const [caseRow, claim, lastEligibilityEvent] = await Promise.all([
        tx.case.findUnique({
          where: { id: caseId },
          select: { policyRoomRentLimit: true },
        }),
        tx.claim.findUnique({
          where: { id: claimId },
          select: { approvedAmount: true },
        }),
        // We don't filter by event type === 'eligibility.failed'
        // here — we take the MOST RECENT eligibility event of
        // either flavour so the card can render the "failed"
        // banner when the last run rejected. The status field
        // below derives the bucket.
        tx.claimEvent.findFirst({
          where: {
            claimId,
            eventType: { in: ['eligibility.verified', 'eligibility.failed'] },
          },
          orderBy: { occurredAt: 'desc' },
          select: {
            eventType: true,
            occurredAt: true,
            payload: true,
          },
        }),
      ]);

      const status: EligibilityVerificationStatus =
        lastEligibilityEvent === null
          ? 'not_run'
          : lastEligibilityEvent.eventType === 'eligibility.verified'
            ? 'verified'
            : 'failed';

      const payload =
        lastEligibilityEvent && isEligibilityPayload(lastEligibilityEvent.payload)
          ? lastEligibilityEvent.payload
          : {};

      return {
        status,
        planName:
          status === 'verified' && typeof payload.planName === 'string'
            ? payload.planName
            : null,
        sumInsured:
          status === 'verified' && typeof payload.sumInsured === 'number'
            ? payload.sumInsured
            : null,
        policyRoomRentLimitPaise: caseRow?.policyRoomRentLimit ?? null,
        approvedToDatePaise: claim?.approvedAmount ?? null,
        verifiedAt:
          lastEligibilityEvent !== null
            ? lastEligibilityEvent.occurredAt.toISOString()
            : null,
        failureReason:
          status === 'failed' && typeof payload.failureReason === 'string'
            ? payload.failureReason
            : null,
      };
    });
  }
}
