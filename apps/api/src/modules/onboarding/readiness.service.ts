import {
  type OnboardingStep,
  type OnboardingStepKey,
  type ReadinessItem,
  type ReadinessReport,
} from '@claims/contracts';
import { Injectable } from '@nestjs/common';

import { OnboardingService } from './onboarding.service';
import { PrismaService } from '../../common/prisma/prisma.service';

// Required steps for go-live. notification_test + payer_master are
// required for PILOT and beyond; package_master is required for LIVE
// only (PMJAY rates lookup) — we'll re-check in run() based on the
// target state once the lifecycle controller forwards it. v1 treats
// them all as required for both since this version of the readiness
// surface is binary (ready / not-ready).
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

    return { ready: items.every((i) => i.ok), items };
  }
}

function prettyKey(key: OnboardingStepKey): string {
  switch (key) {
    case 'tenant_profile':
      return 'Tenant profile';
    case 'roles_assigned':
      return 'Role assignment';
    case 'nhcx_cert':
      return 'NHCX certificate';
    case 'pmjay_state':
      return 'PMJAY state';
    case 'payer_master':
      return 'Payer master';
    case 'package_master':
      return 'Package master';
    case 'notification_test':
      return 'Notification test';
    case 'legal_acceptance':
      return 'Legal acceptance';
  }
}
