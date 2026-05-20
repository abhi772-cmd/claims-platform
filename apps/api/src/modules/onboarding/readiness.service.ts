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
// payer_commercial_terms is intentionally NOT a required STEP flag.
// Its onboarding step exists for the wizard UI, but readiness gates
// on the substantive DATA check below (every EMPANELLED payer has
// terms + room rates) rather than on the admin self-attesting the
// step complete. Gating on truth, not on a flag, avoids the failure
// mode where the flag is ticked but the underlying rows are missing.
const REQUIRED_STEPS: readonly OnboardingStepKey[] = [
  'tenant_profile',
  'roles_assigned',
  'nhcx_cert',
  'payer_master',
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

    // 4. Per-payer commercial terms data check. Verifies the
    //    underlying rows (terms row + room rate per active category)
    //    exist for every EMPANELLED payer. Vacuously satisfied when
    //    the tenant has empanelled no payers yet.
    const status = await this.commercialTerms.listOnboardingStatus(tenantId);
    const incompletePayers = status.payers.filter((p) => !p.fullyComplete).length;
    items.push({
      key: 'data.payer_commercial_terms',
      ok: status.allPayersComplete,
      message:
        status.payers.length === 0
          ? 'No empanelled payers require commercial terms yet.'
          : status.allPayersComplete
            ? `Commercial terms set for all ${status.payers.length} empanelled payer(s).`
            : `Commercial terms incomplete for ${incompletePayers} of ${status.payers.length} empanelled payer(s).`,
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
