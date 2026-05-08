// Idempotent seed for the walking skeleton.
//
// Creates:
//   * One dev tenant (slug: digisparsh-dev), lifecycleState IN_SETUP
//   * 8 default roles per docs/14 Part 3 (platform_admin is platform-wide,
//     i.e. tenantId = NULL; the other 7 are scoped to the dev tenant)
//   * One admin user with role tenant_admin (and platform_admin too in dev)
//
// Run via: pnpm --filter @claims/api db:seed
//
// IMPORTANT: this seed runs against the migrator role (DATABASE_URL_MIGRATOR)
// and uses the platform_admin GUC so RLS is honoured at write time too.

import { argon2id, hash } from 'argon2';
import { Prisma, PrismaClient } from '@prisma/client';

const TENANT_SLUG = 'digisparsh-dev';
const ADMIN_EMAIL = 'abhijeet.sharma@digisparsh.in';
const ADMIN_INITIAL_PASSWORD = 'ChangeMe!Skeleton2026';

interface RoleSeed {
  name: string;
  scope: 'platform' | 'tenant';
  permissions: string[];
}

const ROLE_SEEDS: RoleSeed[] = [
  {
    name: 'platform_admin',
    scope: 'platform',
    permissions: [
      'tenant.create',
      'tenant.update',
      'tenant.lifecycle.transition',
      'tenant.suspend',
      'tenant.churn',
      'user.invite',
      'user.update',
      'user.deactivate',
      'payer.master.view',
      'payer.master.edit',
      'package.master.sync',
      'audit.view',
      'erasure.process',
      'breach_incident.view',
      'breach_incident.manage',
      'tenant.comms_config.update',
    ],
  },
  {
    name: 'tenant_admin',
    scope: 'tenant',
    permissions: [
      'user.invite',
      'user.update',
      'user.deactivate',
      'tenant.update',
      'tenant.lifecycle.transition',
      'tenant.comms_config.update',
      'payer.master.view',
      'payer.master.edit',
      'package.master.sync',
      'document_checklist.edit',
      'case.create',
      'case.view',
      'case.assign',
      'preauth.draft',
      'preauth.submit',
      'preauth.cancel',
      'preauth.respond_query',
      'preauth.approve_internal',
      'claim.draft',
      'claim.submit',
      'claim.reprocess',
      'claim.respond_query',
      'settlement.upload_eob',
      'settlement.categorize_deduct',
      'settlement.appeal',
      'settlement.write_off',
      'analytics.view',
      'analytics.export',
      'audit.view',
      'erasure.process',
      'breach_incident.view',
      'breach_incident.manage',
    ],
  },
  {
    name: 'billing_manager',
    scope: 'tenant',
    permissions: [
      'payer.master.view',
      'document_checklist.edit',
      'case.create',
      'case.view',
      'case.assign',
      'preauth.draft',
      'preauth.submit',
      'preauth.cancel',
      'preauth.respond_query',
      'preauth.approve_internal',
      'claim.draft',
      'claim.submit',
      'claim.reprocess',
      'claim.respond_query',
      'settlement.upload_eob',
      'settlement.categorize_deduct',
      'settlement.appeal',
      'settlement.write_off',
      'analytics.view',
      'analytics.export',
    ],
  },
  {
    name: 'insurance_desk_executive',
    scope: 'tenant',
    permissions: [
      'payer.master.view',
      'case.create',
      'case.view',
      'preauth.draft',
      'preauth.submit',
      'preauth.cancel',
      'preauth.respond_query',
      'claim.draft',
      'claim.submit',
      'claim.reprocess',
      'claim.respond_query',
      'settlement.categorize_deduct',
      'settlement.appeal',
      'analytics.view',
    ],
  },
  {
    name: 'pmam',
    scope: 'tenant',
    permissions: [
      'payer.master.view',
      'case.create',
      'case.view',
      'preauth.draft',
      'preauth.submit',
      'preauth.cancel',
      'preauth.respond_query',
      'claim.draft',
      'claim.submit',
      'claim.reprocess',
      'claim.respond_query',
      'settlement.appeal',
      'analytics.view',
    ],
  },
  {
    name: 'doctor',
    scope: 'tenant',
    permissions: ['case.view', 'preauth.sign_clinical'],
  },
  {
    name: 'finance_viewer',
    scope: 'tenant',
    permissions: ['payer.master.view', 'analytics.view', 'analytics.export'],
  },
  {
    name: 'read_only',
    scope: 'tenant',
    permissions: ['payer.master.view', 'case.view', 'analytics.view'],
  },
];

async function seed(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await prisma.$transaction(async (tx) => {
      // Parameterised set_config — never use $executeRawUnsafe with template strings.
      // platform_admin role bypasses tenant filtering for the seed run.
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );

      const tenant = await tx.tenant.upsert({
        where: { slug: TENANT_SLUG },
        update: {},
        create: {
          slug: TENANT_SLUG,
          displayName: 'DigiSparsh Dev',
          lifecycleState: 'IN_SETUP',
        },
      });

      const roleByName = new Map<string, string>();
      for (const seedRole of ROLE_SEEDS) {
        const tenantId = seedRole.scope === 'platform' ? null : tenant.id;
        // Upsert keyed on (tenantId, name) — Prisma's compound unique requires
        // both fields on the where, even if one is null.
        const existing = await tx.role.findFirst({
          where: { tenantId, name: seedRole.name },
        });
        if (existing) {
          const updated = await tx.role.update({
            where: { id: existing.id },
            data: { permissions: seedRole.permissions },
          });
          roleByName.set(seedRole.name, updated.id);
        } else {
          const created = await tx.role.create({
            data: {
              tenantId,
              name: seedRole.name,
              permissions: seedRole.permissions,
            },
          });
          roleByName.set(seedRole.name, created.id);
        }
      }

      const passwordHash = await hash(ADMIN_INITIAL_PASSWORD, {
        type: argon2id,
        timeCost: 3,
        memoryCost: 65536,
        parallelism: 4,
      });

      const adminUser = await tx.user.upsert({
        where: { email: ADMIN_EMAIL },
        update: {},
        create: {
          tenantId: tenant.id,
          email: ADMIN_EMAIL,
          passwordHash,
          firstName: 'Abhijeet',
          lastName: 'Sharma',
          designation: 'Founder',
          status: 'active',
          mustChangePassword: true,
        },
      });

      const tenantAdminRoleId = roleByName.get('tenant_admin');
      const platformAdminRoleId = roleByName.get('platform_admin');
      if (!tenantAdminRoleId || !platformAdminRoleId) {
        throw new Error('Role seed missing tenant_admin or platform_admin');
      }

      for (const roleId of [tenantAdminRoleId, platformAdminRoleId]) {
        const existing = await tx.userRole.findUnique({
          where: { userId_roleId: { userId: adminUser.id, roleId } },
        });
        if (!existing) {
          await tx.userRole.create({
            data: { tenantId: tenant.id, userId: adminUser.id, roleId },
          });
        }
      }

      // eslint-disable-next-line no-console
      console.log(
        `Seed complete. Tenant=${tenant.slug} adminEmail=${adminUser.email} (initial password: ${ADMIN_INITIAL_PASSWORD})`,
      );
    });
  } finally {
    await prisma.$disconnect();
  }
}

void seed().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
