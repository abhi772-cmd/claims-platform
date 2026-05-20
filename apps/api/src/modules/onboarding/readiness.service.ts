import {
  type OnboardingStep,
  type OnboardingStepKey,
  type ReadinessItem,
  type ReadinessReport,
} from '@claims/contracts';
import { Injectable } from '@nestjs/common';

import { OnboardingService } from './onboarding.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PayerCommercialTermsService } from '../payer-commercial-terms';

// Required steps for go-live. notification_test + payer_master are
// required for PILOT and beyond; package_master is required for LIVE
// only (PMJAY rates lookup) — we'll re-check in run() based on the
// target state once the lifecycle controller forwards it. v1 treats
// them all as required for both since this version of the readiness
// surface is binary (ready / not-ready).
//
// payer_commercial_terms is gated TWO ways: the step flag itself
// (admin marked it complete) AND the data check below (every active
// payer has terms + room rates). Belt and braces — admins sometimes
// flip the step flag prematurely.
const REQUIRED_STEPS: readonly OnboardingStepKey[] = [
  'tenant_profile',
  'roles_assigned',
  'nhcx_cert',
  'payer_master',
  'payer_commercial_terms',
  'package_master',
  'notification_test',
  'legal_acceptance',
];

@Injectable()
export class ReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly onboarding: OnboardingService,
    private readonly commercialTerms: PayerCommercialTermsService,
  ) {}

  async run(tenantId: string): Promise<ReadinessReport> {
    const steps = await this.onboarding.list(tenantId);
    const items: ReadinessItem[] = [];

    // 1. Each required onboarding step must be completed.
    const byKey = new Map(steps.map((s: OnboardingStep) => [s.key, s]));
    for (const key of REQUIRED_STEPS) {
      const step = byKey.get(key);
      const completed = step?.status === 'completed';
      items.push({
        key: `step.${key}`,
        ok: completed,
        message: completed
          ? `${prettyKey(key)} is complete.`
          : `${prettyKey(key)} is incomplete.`,
      });
    }

    // 2. At least one user with a tenant_admin role.
    const adminCount = await this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      return tx.userRole.count({
        where: {
          tenantId,
          role: { name: 'tenant_admin' },
          user: { status: 'active' },
        },
      });
    });
    items.push({
      key: 'role.tenant_admin',
      ok: adminCount >= 1,
      message:
        adminCount >= 1
          ? `Found ${adminCount} active tenant admin(s).`
          : 'No active tenant admin assigned.',
    });

    // 3. Tenant must not be in a terminal lifecycle state.
    const tenant = await this.prisma.runInTenantContext(tenantId, 'tenant', (tx) =>
      tx.tenant.findUnique({ where: { id: tenantId }, select: { lifecycleState: true } }),
    );
    const terminal = tenant?.lifecycleState === 'CHURNED';
    items.push({
      key: 'lifecycle.not_terminal',
      ok: !terminal,
      message: terminal ? 'Tenant is CHURNED.' : 'Lifecycle is not terminal.',
    });

    // 4. Per-payer commercial terms data check. The step-flag check
    //    above only confirms the admin clicked "mark complete"; this
    //    one verifies the underlying rows (terms row + room rate per
    //    category per payer) actually exist.
    const status = await this.commercialTerms.listOnboardingStatus(tenantId);
    items.push({
      key: 'data.payer_commercial_terms',
      ok: status.allPayersComplete,
      message: status.allPayersComplete
        ? `Commercial terms set for all ${status.payers.length} active payer(s).`
        : `Commercial terms incomplete for ${status.payers.filter((p) => !p.fullyComplete).length} of ${status.payers.length} active payer(s).`,
    });

    return { ready: items.every((i) => i.ok), items };
  }
}

function prettyKey(key: OnboardingStepKey): string {
  switch (key) {
    case 'tenant_profile':
      return 'Tenant profile';
    case 'roles_assigned':
      return 'Role assignment';
    case 'hfr_facility':
      return 'HFR facility registered';
    case 'nhcx_participant_code':
      return 'NHCX participant code';
    case 'nhcx_cert':
      return 'NHCX certificate';
    case 'nhcx_callback_url':
      return 'NHCX callback URL';
    case 'pmjay_state':
      return 'PMJAY state';
    case 'payer_master':
      return 'Payer master';
    case 'payer_commercial_terms':
      return 'Payer commercial terms';
    case 'package_master':
      return 'Package master';
    case 'notification_test':
      return 'Notification test';
    case 'legal_acceptance':
      return 'Legal acceptance';
  }
}
