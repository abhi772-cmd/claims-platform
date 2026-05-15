import {
  type AuditLogEntry,
  type CreateTenantRequest,
  type CreateTenantResponse,
  type OnboardingStep,
  type OnboardingStepKey,
  type OnboardingStepStatus,
  type ResendPrimaryInviteResponse,
  type TenantAdminDetailResponse,
  type TenantAdminListResponse,
  type TenantLifecycleState,
  type TenantPrimaryAdminSummary,
} from '@claims/contracts';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { TenantNotFoundError } from '../../common/errors/tenant-errors';
import { UserNotFoundError } from '../../common/errors/user-errors';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { type TenantPrisma } from '../../types/express';
import { AuditEvents, AuditService } from '../audit';
import { InviteService } from '../user/invite.service';

// Platform-admin: create a new hospital tenant + invite the primary
// admin in one operator action. The flow is:
//   1. platform_admin tx — create tenant row, seed the 7 tenant-scoped
//      roles for this tenant (from DEFAULT_TENANT_ROLES below), audit
//   2. delegate to InviteService.invite() with tenantId + tenant_admin
//      role — it creates the user + sends the invite email/SMS
// Step 2 runs outside the platform tx because InviteService opens its
// own tenant context. Failure to invite leaves the tenant + roles in
// place — ops can retry the invite without re-provisioning the tenant.

// Default tenant-scoped roles per docs/14 Part 3. MUST stay in sync
// with the same list in apps/api/prisma/seed.ts ROLE_SEEDS — that
// file seeds the dev tenant on bootstrap; this one seeds every new
// tenant created via /admin/tenants. Drift between the two means
// new hospitals get a different role set than the dev tenant, which
// breaks integration tests + RBAC assumptions silently.
interface DefaultTenantRole {
  name: string;
  permissions: readonly string[];
}
const DEFAULT_TENANT_ROLES: readonly DefaultTenantRole[] = [
  {
    name: 'tenant_admin',
    permissions: [
      'user.invite',
      'user.update',
      'user.deactivate',
      'tenant.update',
      'tenant.lifecycle.transition',
      'tenant.comms_config.update',
      'tenant.onboarding.update',
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
      'consent.view',
      'consent.manage',
    ],
  },
  {
    name: 'billing_manager',
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
      'consent.view',
      'consent.manage',
    ],
  },
  {
    name: 'insurance_desk_executive',
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
      'consent.view',
      'consent.manage',
    ],
  },
  {
    name: 'pmam',
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
  { name: 'doctor', permissions: ['case.view', 'preauth.sign_clinical'] },
  {
    name: 'finance_viewer',
    permissions: ['payer.master.view', 'analytics.view', 'analytics.export'],
  },
  { name: 'read_only', permissions: ['payer.master.view', 'case.view', 'analytics.view'] },
];

export interface CreateTenantServiceInput extends CreateTenantRequest {
  actorUserId: string;
  ip: string | null;
  userAgent: string | null;
}

@Injectable()
export class TenantAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly invites: InviteService,
  ) {}

  async list(): Promise<TenantAdminListResponse> {
    return runAsPlatformAdmin(this.prisma, async (tx) => {
      const tenants = await tx.tenant.findMany({
        orderBy: [{ createdAt: 'desc' }],
        select: {
          id: true,
          slug: true,
          displayName: true,
          lifecycleState: true,
          createdAt: true,
          _count: { select: { users: { where: { status: 'active' } } } },
        },
      });

      // Per-tenant primary admin lookup. The "primary admin" is the
      // user with tenant_admin role who was created earliest — almost
      // always the user invited at tenant creation. We do one pass per
      // tenant; for the platform-ops listing this is fine (tens, not
      // thousands of tenants). If the list grows, batch via a single
      // query joining tenant -> userRole -> role.
      const items = await Promise.all(
        tenants.map(async (t) => {
          const primaryAdmin = await findPrimaryAdmin(tx, t.id);
          return {
            id: t.id,
            slug: t.slug,
            displayName: t.displayName,
            lifecycleState: t.lifecycleState as TenantLifecycleState,
            createdAt: t.createdAt.toISOString(),
            activeUserCount: t._count.users,
            primaryAdmin,
          };
        }),
      );
      return { items };
    });
  }

  async detail(tenantId: string): Promise<TenantAdminDetailResponse> {
    return runAsPlatformAdmin(this.prisma, async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: {
          id: true,
          slug: true,
          displayName: true,
          lifecycleState: true,
          createdAt: true,
          updatedAt: true,
          _count: {
            select: {
              users: { where: { status: 'active' } },
            },
          },
        },
      });
      if (!tenant) throw new TenantNotFoundError();

      const invitedCount = await tx.user.count({
        where: { tenantId, status: 'invited' },
      });
      const primaryAdmin = await findPrimaryAdmin(tx, tenantId);
      const stepRows = await tx.onboardingStep.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'asc' },
      });
      const onboardingSteps: OnboardingStep[] = stepRows.map((s) => ({
        key: s.stepKey as OnboardingStepKey,
        status: s.status as OnboardingStepStatus,
        completedAt: s.completedAt ? s.completedAt.toISOString() : null,
        evidence: (s.evidence as Record<string, unknown>) ?? {},
      }));

      // Last 20 audit rows for this tenant — ops "recent activity"
      // panel. Cheap query (tenantId index) and bounded.
      const auditRows = await tx.auditLog.findMany({
        where: { tenantId },
        orderBy: { occurredAt: 'desc' },
        take: 20,
      });
      const recentActivity: AuditLogEntry[] = auditRows.map((r) => ({
        id: r.id,
        occurredAt: r.occurredAt.toISOString(),
        actorUserId: r.actorUserId,
        actorType: r.actorType as AuditLogEntry['actorType'],
        action: r.action,
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        before: r.before,
        after: r.after,
        ipAddress: r.ipAddress,
        userAgent: r.userAgent,
        correlationId: r.correlationId,
      }));

      return {
        tenant: {
          id: tenant.id,
          slug: tenant.slug,
          displayName: tenant.displayName,
          lifecycleState: tenant.lifecycleState as TenantLifecycleState,
          createdAt: tenant.createdAt.toISOString(),
          updatedAt: tenant.updatedAt.toISOString(),
        },
        primaryAdmin,
        activeUserCount: tenant._count.users,
        invitedUserCount: invitedCount,
        onboardingSteps,
        recentActivity,
      };
    });
  }

  // Cross-tenant resend on behalf of the hospital. Resolves the target
  // tenant + user, validates the user is actually that tenant's invitee,
  // and delegates to InviteService.resend which handles the resend
  // rate limit + audit + outbox dispatch.
  async resendPrimaryInvite(input: {
    tenantId: string;
    targetUserId: string;
    actorUserId: string;
    ip: string | null;
    userAgent: string | null;
  }): Promise<ResendPrimaryInviteResponse> {
    // Pre-check: tenant + user exist and the user lives in that tenant.
    // We do this in a platform_admin context because the actor doesn't
    // hold a session in the target tenant. InviteService.resend then
    // opens its own tenant context for the actual resend work.
    await runAsPlatformAdmin(this.prisma, async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: input.tenantId },
        select: { id: true },
      });
      if (!tenant) throw new TenantNotFoundError();
      const user = await tx.user.findUnique({
        where: { id: input.targetUserId },
        select: { tenantId: true },
      });
      if (!user || user.tenantId !== input.tenantId) {
        throw new UserNotFoundError();
      }
    });

    const { inviteExpiresAt } = await this.invites.resend(
      input.tenantId,
      input.targetUserId,
      input.actorUserId,
      input.ip,
      input.userAgent,
    );
    return { inviteExpiresAt: inviteExpiresAt.toISOString() };
  }

  async create(input: CreateTenantServiceInput): Promise<CreateTenantResponse> {
    // Step 1: provision the tenant + roles in one platform_admin tx.
    // Slug + email uniqueness checks happen here so a duplicate either
    // dimension fails before any side effects.
    const provisioned = await runAsPlatformAdmin(this.prisma, async (tx) => {
      const existingSlug = await tx.tenant.findUnique({
        where: { slug: input.slug },
        select: { id: true },
      });
      if (existingSlug) {
        throw new ValidationFailedError({
          slug: [`Slug "${input.slug}" is already in use.`],
        });
      }
      const existingEmail = await tx.user.findUnique({
        where: { email: input.primaryAdmin.email },
        select: { id: true },
      });
      if (existingEmail) {
        throw new ValidationFailedError({
          'primaryAdmin.email': [
            `A user with email "${input.primaryAdmin.email}" already exists. Pick a different email or reset the existing account.`,
          ],
        });
      }

      const tenant = await tx.tenant.create({
        data: {
          slug: input.slug,
          displayName: input.displayName,
          lifecycleState: 'IN_SETUP',
        },
        select: {
          id: true,
          slug: true,
          displayName: true,
          lifecycleState: true,
        },
      });

      for (const role of DEFAULT_TENANT_ROLES) {
        await tx.role.create({
          data: {
            tenantId: tenant.id,
            name: role.name,
            permissions: [...role.permissions],
          },
        });
      }

      await this.audit.recordWithTx(tx, {
        tenantId: tenant.id,
        actorUserId: input.actorUserId,
        actorType: 'user',
        action: AuditEvents.TENANT_CREATED,
        resourceType: 'tenant',
        resourceId: tenant.id,
        before: null,
        after: {
          slug: tenant.slug,
          displayName: tenant.displayName,
          lifecycleState: tenant.lifecycleState,
        },
        ipAddress: input.ip,
        userAgent: input.userAgent,
      });

      return tenant;
    });

    // Step 2: invite the primary admin. InviteService opens its own
    // tenant context. If this fails the tenant + roles are already
    // committed — ops retries via /tenant/users/:id/resend-invite
    // semantics once a user exists, or by re-POSTing /admin/tenants
    // with a different email if no user got created.
    const invited = await this.invites.invite(
      {
        tenantId: provisioned.id,
        invitedById: input.actorUserId,
        email: input.primaryAdmin.email,
        firstName: input.primaryAdmin.firstName,
        lastName: input.primaryAdmin.lastName,
        ...(input.primaryAdmin.mobile !== undefined
          ? { mobile: input.primaryAdmin.mobile }
          : {}),
        ...(input.primaryAdmin.designation !== undefined
          ? { designation: input.primaryAdmin.designation }
          : {}),
        roles: ['tenant_admin'],
      },
      input.ip,
      input.userAgent,
    );

    return {
      tenant: {
        id: provisioned.id,
        slug: provisioned.slug,
        displayName: provisioned.displayName,
        lifecycleState: provisioned.lifecycleState as TenantLifecycleState,
      },
      primaryAdmin: {
        id: invited.id,
        email: invited.email,
        inviteExpiresAt: invited.inviteExpiresAt.toISOString(),
      },
    };
  }
}

// Resolves a tenant's primary admin (oldest user holding the
// `tenant_admin` role for this tenant). Returns null when the tenant
// has no tenant_admin user yet — the seed-only dev tenant, or tenants
// where the primary admin was deactivated. The caller is expected to
// already be inside a platform_admin tx so RLS lets us cross tenant
// boundaries.
async function findPrimaryAdmin(
  tx: TenantPrisma,
  tenantId: string,
): Promise<TenantPrimaryAdminSummary | null> {
  const link = await tx.userRole.findFirst({
    where: {
      tenantId,
      role: { name: 'tenant_admin' },
    },
    orderBy: { user: { createdAt: 'asc' } },
    select: {
      user: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          status: true,
          inviteAcceptedAt: true,
          inviteTokenExpiresAt: true,
        },
      },
    },
  });
  if (!link?.user) return null;
  const u = link.user;
  const stillInvited = u.status === 'invited' && !u.inviteAcceptedAt;
  const expiresAt =
    stillInvited && u.inviteTokenExpiresAt ? u.inviteTokenExpiresAt : null;
  const expired = stillInvited
    ? !u.inviteTokenExpiresAt || u.inviteTokenExpiresAt.getTime() < Date.now()
    : false;
  return {
    id: u.id,
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    status: u.status,
    inviteExpiresAt: expiresAt ? expiresAt.toISOString() : null,
    inviteExpired: expired,
  };
}

async function runAsPlatformAdmin<T>(
  prisma: PrismaService,
  cb: (tx: TenantPrisma) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      return cb(tx as unknown as TenantPrisma);
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}
