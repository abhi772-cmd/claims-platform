// Comprehensive demo-walkthrough seeder. Builds a full, navigable
// dataset across 6 hospitals at different lifecycle stages with
// ~150 patients and ~140 cases covering every claim status, both
// rails (NHCX + PMJAY), and the major edge cases. Designed to be
// the canonical "open this and demo" dataset.
//
// Idempotent: the seed wipes everything matching the demo tenant
// slugs first, then rebuilds. Your existing digisparsh-dev tenant
// (from prisma/seed.ts) is NOT touched.
//
// Run:    pnpm --filter @claims/api db:seed:demo:walkthrough
// Reset:  re-run the same command — it wipes + recreates idempotently.
//
// Login credentials for the demo:
//   * Every active demo tenant has 5 users — tenant_admin,
//     sr_operator, operator, doctor, finance
//   * Email pattern: <role>@<tenant-slug>.demo
//     e.g. admin@apollo-mumbai.demo, operator@narayana-bangalore.demo
//   * Password (every user): Demo@2026
//
// Tenants:
//   * apollo-mumbai       active, NHCX + PMJAY, ~60 cases
//   * narayana-bangalore  active, NHCX only,    ~40 cases
//   * aiims-delhi         active, PMJAY heavy,  ~40 cases
//   * medanta-gurgaon     mid-onboarding (some steps complete)
//   * manipal-pune        just-registered (fresh tenant)
//   * fortis-chennai      suspended (lifecycle escalated)

import { argon2id, hash } from 'argon2';
import { Prisma, PrismaClient } from '@prisma/client';

import { seedCasesForTenant } from './seed-demo-walkthrough-cases';

// ---------- Constants ----------

const DEMO_PASSWORD = 'Demo@2026';

interface UserDef {
  email: string;
  firstName: string;
  lastName: string;
  designation: string;
  roleNames: string[];
}

interface TenantDef {
  slug: string;
  displayName: string;
  lifecycleState: 'CONTRACTED' | 'PROVISIONING' | 'IN_SETUP' | 'PILOT' | 'LIVE' | 'SUSPENDED' | 'CHURNED';
  pmjayMode: 'on' | 'off';
  requireConsent: boolean;
  caseCount: number;
  onboardingStage: 'fresh' | 'partial' | 'complete';
  // Optional: distribution overrides for the case generator. Default
  // distribution covers every claim status; tenants can narrow.
  rails: Array<'nhcx' | 'pmjay' | 'self_pay'>;
  users: UserDef[];
}

const ACTIVE_TENANT_USERS: UserDef[] = [
  {
    email: 'admin',
    firstName: 'Priya',
    lastName: 'Sharma',
    designation: 'Hospital Administrator',
    roleNames: ['tenant_admin'],
  },
  {
    email: 'sr_operator',
    firstName: 'Rajesh',
    lastName: 'Kumar',
    designation: 'Senior Claims Operator',
    roleNames: ['claims_operator', 'claims_supervisor'],
  },
  {
    email: 'operator',
    firstName: 'Anita',
    lastName: 'Desai',
    designation: 'Claims Operator',
    roleNames: ['claims_operator'],
  },
  {
    email: 'doctor',
    firstName: 'Vikram',
    lastName: 'Iyer',
    designation: 'Treating Physician',
    roleNames: ['treating_doctor'],
  },
  {
    email: 'finance',
    firstName: 'Sneha',
    lastName: 'Patel',
    designation: 'CFO',
    roleNames: ['finance_user'],
  },
];

const INACTIVE_TENANT_USERS: UserDef[] = [
  {
    email: 'admin',
    firstName: 'Mohit',
    lastName: 'Kapoor',
    designation: 'Hospital Administrator',
    roleNames: ['tenant_admin'],
  },
];

const TENANTS: TenantDef[] = [
  {
    slug: 'apollo-mumbai',
    displayName: 'Apollo Hospital, Mumbai',
    lifecycleState: 'LIVE',
    pmjayMode: 'on',
    requireConsent: false,
    caseCount: 60,
    onboardingStage: 'complete',
    rails: ['nhcx', 'pmjay', 'self_pay'],
    users: ACTIVE_TENANT_USERS,
  },
  {
    slug: 'narayana-bangalore',
    displayName: 'Narayana Health, Bangalore',
    lifecycleState: 'LIVE',
    pmjayMode: 'off',
    requireConsent: false,
    caseCount: 40,
    onboardingStage: 'complete',
    rails: ['nhcx', 'self_pay'],
    users: ACTIVE_TENANT_USERS,
  },
  {
    slug: 'aiims-delhi',
    displayName: 'AIIMS, Delhi',
    lifecycleState: 'LIVE',
    pmjayMode: 'on',
    requireConsent: true,
    caseCount: 40,
    onboardingStage: 'complete',
    rails: ['pmjay', 'nhcx'],
    users: ACTIVE_TENANT_USERS,
  },
  {
    slug: 'medanta-gurgaon',
    displayName: 'Medanta, Gurgaon',
    lifecycleState: 'IN_SETUP',
    pmjayMode: 'off',
    requireConsent: false,
    caseCount: 0,
    onboardingStage: 'partial',
    rails: ['nhcx'],
    users: INACTIVE_TENANT_USERS,
  },
  {
    slug: 'manipal-pune',
    displayName: 'Manipal, Pune',
    lifecycleState: 'IN_SETUP',
    pmjayMode: 'off',
    requireConsent: false,
    caseCount: 0,
    onboardingStage: 'fresh',
    rails: ['nhcx'],
    users: INACTIVE_TENANT_USERS,
  },
  {
    slug: 'fortis-chennai',
    displayName: 'Fortis, Chennai',
    lifecycleState: 'SUSPENDED',
    pmjayMode: 'off',
    requireConsent: false,
    caseCount: 5,
    onboardingStage: 'complete',
    rails: ['nhcx'],
    users: INACTIVE_TENANT_USERS,
  },
];

// Role permissions per name. Subset of the canonical set in seed.ts —
// we re-state here so the demo seed runs standalone without depending
// on the bootstrap seed's role rows for non-admin scopes.
const ROLE_SEEDS: Array<{ name: string; permissions: string[] }> = [
  {
    name: 'tenant_admin',
    permissions: [
      'user.invite', 'user.update', 'user.deactivate', 'tenant.update',
      'tenant.lifecycle.transition', 'tenant.comms_config.update',
      'payer.master.view', 'payer.master.edit', 'package.master.sync',
      'document_checklist.edit', 'case.create', 'case.view', 'case.assign',
      'preauth.draft', 'preauth.submit', 'preauth.cancel',
      'preauth.respond_query', 'claim.draft', 'claim.submit',
      'claim.respond_query', 'settlement.upload_eob', 'analytics.view',
      'audit.view', 'consent.view', 'consent.manage',
    ],
  },
  {
    name: 'claims_supervisor',
    permissions: [
      'case.view', 'case.assign', 'preauth.draft', 'preauth.submit',
      'preauth.respond_query', 'preauth.approve_internal', 'claim.draft',
      'claim.submit', 'claim.respond_query', 'settlement.upload_eob',
      'analytics.view',
    ],
  },
  {
    name: 'claims_operator',
    permissions: [
      'case.create', 'case.view', 'preauth.draft', 'preauth.submit',
      'preauth.respond_query', 'claim.draft', 'claim.submit',
      'claim.respond_query', 'settlement.upload_eob',
    ],
  },
  {
    name: 'treating_doctor',
    permissions: ['case.view', 'preauth.respond_query'],
  },
  {
    name: 'finance_user',
    permissions: [
      'case.view', 'settlement.upload_eob',
      'settlement.categorize_deduct', 'analytics.view',
    ],
  },
];

// Onboarding step keys per docs/14. The seed stamps these to
// completion levels per tenant stage so the admin/onboarding page
// shows realistic progress per tenant.
const ONBOARDING_STEPS = [
  'tenant_profile',
  'rail_selection',
  'comms_config',
  'first_admin_invite',
  'first_payer_credentials',
  'first_package_master',
  'doctor_roster',
  'test_eligibility',
  'go_live_review',
];

// ---------- Helpers ----------

async function setRole(tx: Prisma.TransactionClient, role: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${role}, true)`);
}

async function setTenantId(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
  await tx.$executeRaw(
    Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
  );
}

// Wipes EVERYTHING for a given tenant ID, in FK-dependency order, so
// re-running the seed produces identical state. The relation surface
// of tenant data is large — anything keyed on tenantId gets a
// deleteMany call here. Run inside the platform_admin GUC.
async function cleanupTenant(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
  // Set tenant GUC so tenant-scoped RLS policies allow the deletes.
  await setTenantId(tx, tenantId);

  // The deletes below run leaf-first so cascade FKs don't fail.
  // Tables WITHOUT a Prisma cascade on tenantId must be deleted
  // explicitly. Tables that cascade via Tenant → User → child
  // (sessions, mfa rows, etc.) are skipped — the tenant delete at
  // the end takes care of them.

  // Claim-trail tables
  await tx.integrationMessage.deleteMany({ where: { tenantId } });
  await tx.preauthQuery.deleteMany({ where: { tenantId } });
  await tx.preauthDraft.deleteMany({ where: { tenantId } });
  await tx.appeal.deleteMany({ where: { tenantId } });
  await tx.settlement.deleteMany({ where: { tenantId } });
  await tx.eobLineMatchItem.deleteMany({ where: { tenantId } });
  await tx.eobLineMatch.deleteMany({ where: { tenantId } });
  await tx.billLineItem.deleteMany({ where: { tenantId } });
  await tx.claimEvent.deleteMany({ where: { tenantId } });
  await tx.document.deleteMany({ where: { tenantId } });

  // Case / claim level
  await tx.biometricVerification.deleteMany({ where: { tenantId } });
  await tx.claim.deleteMany({ where: { tenantId } });
  await tx.case.deleteMany({ where: { tenantId } });
  await tx.patient.deleteMany({ where: { tenantId } });

  // Notification + audit
  await tx.notificationOutbox.deleteMany({ where: { tenantId } });
  await tx.dataAccessEvent.deleteMany({ where: { tenantId } });
  await tx.consentRecord.deleteMany({ where: { tenantId } });
  await tx.breachIncident.deleteMany({ where: { tenantId } });
  await tx.erasureRequest.deleteMany({ where: { tenantId } });
  await tx.auditLog.deleteMany({ where: { tenantId } });

  // Auth + tenant config
  await tx.userRole.deleteMany({ where: { tenantId } });
  await tx.user.deleteMany({ where: { tenantId } });
  await tx.role.deleteMany({ where: { tenantId } });
  await tx.onboardingStep.deleteMany({ where: { tenantId } });
}

async function ensureRolesForTenant(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const seed of ROLE_SEEDS) {
    const role = await tx.role.create({
      data: {
        tenantId,
        name: seed.name,
        permissions: seed.permissions,
      },
    });
    map.set(seed.name, role.id);
  }
  return map;
}

async function seedUsersForTenant(
  tx: Prisma.TransactionClient,
  tenant: TenantDef,
  tenantId: string,
  roleByName: Map<string, string>,
  passwordHash: string,
): Promise<string[]> {
  const userIds: string[] = [];
  for (const userDef of tenant.users) {
    const email = `${userDef.email}@${tenant.slug}.demo`;
    const user = await tx.user.create({
      data: {
        tenantId,
        email,
        passwordHash,
        firstName: userDef.firstName,
        lastName: userDef.lastName,
        designation: userDef.designation,
        status: 'active',
        mustChangePassword: false,
        inviteAcceptedAt: new Date(),
        lastPasswordChangeAt: new Date(),
      },
    });
    userIds.push(user.id);
    for (const roleName of userDef.roleNames) {
      const roleId = roleByName.get(roleName);
      if (!roleId) continue;
      await tx.userRole.create({
        data: { tenantId, userId: user.id, roleId },
      });
    }
  }
  return userIds;
}

async function seedOnboardingSteps(
  tx: Prisma.TransactionClient,
  tenantId: string,
  stage: TenantDef['onboardingStage'],
  adminUserId: string,
): Promise<void> {
  // 'fresh'    only tenant_profile complete
  // 'partial'  half the steps complete
  // 'complete' all steps complete
  const completeCount =
    stage === 'fresh' ? 1 : stage === 'partial' ? 5 : ONBOARDING_STEPS.length;
  for (let i = 0; i < ONBOARDING_STEPS.length; i += 1) {
    const stepKey = ONBOARDING_STEPS[i];
    if (!stepKey) continue;
    const isComplete = i < completeCount;
    await tx.onboardingStep.create({
      data: {
        tenantId,
        stepKey,
        status: isComplete ? 'completed' : 'pending',
        evidence: isComplete ? { completedVia: 'demo_seed' } : {},
        ...(isComplete ? { completedAt: new Date(), completedBy: adminUserId } : {}),
      },
    });
  }
}

// ---------- Main orchestrator ----------

async function seedDemoWalkthrough(): Promise<void> {
  const prisma = new PrismaClient();
  const passwordHash = await hash(DEMO_PASSWORD, {
    type: argon2id,
    timeCost: 3,
    memoryCost: 65536,
    parallelism: 4,
  });

  try {
    // Phase 1 — cleanup. Each tenant in its own transaction so a
    // partial run that fails halfway leaves the rest of the demo
    // state untouched.
    for (const tenant of TENANTS) {
      await prisma.$transaction(async (tx) => {
        await setRole(tx, 'platform_admin');
        const existing = await tx.tenant.findUnique({
          where: { slug: tenant.slug },
          select: { id: true },
        });
        if (existing) {
          // eslint-disable-next-line no-console
          console.log(`[wipe] ${tenant.slug} (id=${existing.id})`);
          await cleanupTenant(tx, existing.id);
          await tx.tenant.delete({ where: { id: existing.id } });
        }
      });
    }

    // Phase 2 — create each tenant with users, roles, onboarding,
    // patients, cases. Each tenant in its own transaction for the
    // same partial-failure isolation.
    for (const tenant of TENANTS) {
      await prisma.$transaction(
        async (tx) => {
          await setRole(tx, 'platform_admin');

          const created = await tx.tenant.create({
            data: {
              slug: tenant.slug,
              displayName: tenant.displayName,
              lifecycleState: tenant.lifecycleState,
              pmjayMode: tenant.pmjayMode,
              requireConsent: tenant.requireConsent,
              commsConfig: {
                smtp: { host: 'mailhog', port: 1025 },
                sms: { provider: 'console_stub' },
              },
            },
          });

          await setTenantId(tx, created.id);

          const roleByName = await ensureRolesForTenant(tx, created.id);
          const userIds = await seedUsersForTenant(
            tx,
            tenant,
            created.id,
            roleByName,
            passwordHash,
          );
          const adminUserId = userIds[0];
          if (!adminUserId) throw new Error(`No users seeded for ${tenant.slug}`);

          await seedOnboardingSteps(tx, created.id, tenant.onboardingStage, adminUserId);

          if (tenant.caseCount > 0) {
            await seedCasesForTenant(tx, {
              tenantId: created.id,
              tenantSlug: tenant.slug,
              caseCount: tenant.caseCount,
              rails: tenant.rails,
              actorUserIds: userIds,
            });
          }

          // eslint-disable-next-line no-console
          console.log(
            `[seed] ${tenant.slug} state=${tenant.lifecycleState} users=${userIds.length} cases=${tenant.caseCount}`,
          );
        },
        { timeout: 120_000 }, // 2 min — case generation is heavy
      );
    }

    // eslint-disable-next-line no-console
    console.log('\nDemo walkthrough seed complete.');
    // eslint-disable-next-line no-console
    console.log(`Login URL: http://localhost:3000/login`);
    // eslint-disable-next-line no-console
    console.log(`Password (all demo users): ${DEMO_PASSWORD}`);
    // eslint-disable-next-line no-console
    console.log(`\nTry: admin@apollo-mumbai.demo`);
  } finally {
    await prisma.$disconnect();
  }
}

void seedDemoWalkthrough().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
