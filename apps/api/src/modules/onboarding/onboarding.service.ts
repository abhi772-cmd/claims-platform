import {
  type OnboardingStep,
  type OnboardingStepKey,
  type OnboardingStepStatus,
} from '@claims/contracts';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditEvents, AuditService } from '../audit';

const ALL_STEP_KEYS: readonly OnboardingStepKey[] = [
  'tenant_profile',
  'roles_assigned',
  'hfr_facility',
  'nhcx_participant_code',
  'nhcx_cert',
  'nhcx_callback_url',
  'pmjay_state',
  'payer_master',
  'package_master',
  'notification_test',
  'legal_acceptance',
];

export interface CompleteStepInput {
  tenantId: string;
  actorUserId: string;
  stepKey: OnboardingStepKey;
  status: OnboardingStepStatus;
  evidence: Record<string, unknown>;
  ip: string | null;
  userAgent: string | null;
}

@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // Returns one entry per canonical step. Steps that have never been
  // touched are returned with status='pending' + empty evidence — saves
  // the caller from joining + null-checking.
  async list(tenantId: string): Promise<OnboardingStep[]> {
    const rows = await this.prisma.runInTenantContext(tenantId, 'tenant', (tx) =>
      tx.onboardingStep.findMany({ where: { tenantId } }),
    );
    const byKey = new Map(rows.map((r) => [r.stepKey, r]));
    return ALL_STEP_KEYS.map((key) => {
      const row = byKey.get(key);
      if (!row) {
        return { key, status: 'pending' as const, completedAt: null, evidence: {} };
      }
      return {
        key,
        status: row.status as OnboardingStepStatus,
        completedAt: row.completedAt ? row.completedAt.toISOString() : null,
        evidence: (row.evidence as Record<string, unknown>) ?? {},
      };
    });
  }

  async complete(input: CompleteStepInput): Promise<OnboardingStep> {
    const status = input.status;
    const completedAt = status === 'completed' || status === 'skipped' ? new Date() : null;
    return this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      const before = await tx.onboardingStep.findUnique({
        where: { tenantId_stepKey: { tenantId: input.tenantId, stepKey: input.stepKey } },
      });
      const row = await tx.onboardingStep.upsert({
        where: { tenantId_stepKey: { tenantId: input.tenantId, stepKey: input.stepKey } },
        create: {
          tenantId: input.tenantId,
          stepKey: input.stepKey,
          status,
          evidence: input.evidence as never,
          completedAt,
          completedBy: input.actorUserId,
        },
        update: {
          status,
          evidence: input.evidence as never,
          completedAt,
          completedBy: input.actorUserId,
        },
      });
      await this.audit.recordWithTx(tx, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        actorType: 'user',
        action: AuditEvents.TENANT_UPDATED,
        resourceType: 'onboarding_step',
        resourceId: row.id,
        before: before
          ? {
              status: before.status,
              evidence: before.evidence,
            }
          : { status: 'pending' },
        after: { stepKey: input.stepKey, status, evidence: input.evidence },
        ipAddress: input.ip,
        userAgent: input.userAgent,
      });
      return {
        key: input.stepKey,
        status,
        completedAt: row.completedAt ? row.completedAt.toISOString() : null,
        evidence: (row.evidence as Record<string, unknown>) ?? {},
      };
    });
  }
}
