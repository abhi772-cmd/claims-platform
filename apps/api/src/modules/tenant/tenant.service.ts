import { Injectable } from '@nestjs/common';

import { ValidationFailedError } from '../../common/errors/validation-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditEvents, AuditService } from '../audit';

interface TenantSummary {
  id: string;
  slug: string;
  displayName: string;
  lifecycleState: string;
  // Slice BG — 'on' = PMJAY-via-NHCX flow active; preauth + claim
  // submit gate on biometric verification. 'off' (default) skips
  // the gate.
  pmjayMode: string;
  // Slice CG — true = DPDP §6 hard enforcement active; missing
  // consent on any preauth / claim / discharge throws
  // ConsentRequiredError. false (default) = soft binding from CB.
  requireConsent: boolean;
}

@Injectable()
export class TenantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // The tenant table's SELECT policy requires app.tenant_id to be set
  // to the row's id (or app.role='platform_admin'). Since we're looking
  // up a tenant by its own id, we set the context to that id before the
  // read so the RLS policy permits the SELECT. Without this, findUnique
  // returns null even when the row exists — which silently bypassed
  // the BG biometric gate (PMJAY tenants reading their own pmjayMode).
  async findById(id: string): Promise<TenantSummary | null> {
    return this.prisma.runInTenantContext(id, 'tenant', (tx) =>
      tx.tenant.findUnique({
        where: { id },
        select: {
          id: true,
          slug: true,
          displayName: true,
          lifecycleState: true,
          pmjayMode: true,
          requireConsent: true,
        },
      }),
    );
  }

  async findBySlug(slug: string): Promise<TenantSummary | null> {
    // Slug → id resolution can't pre-set the tenant context (we don't
    // know the id yet). No call site today; if a caller appears, route
    // it through a platform-admin-scoped runInTenantContext.
    return this.prisma.tenant.findUnique({
      where: { slug },
      select: {
        id: true,
        slug: true,
        displayName: true,
        lifecycleState: true,
        pmjayMode: true,
        requireConsent: true,
      },
    });
  }

  // Slice CG — flip the DPDP §6 hard-enforcement flag for a tenant.
  // Operators flip from `false` → `true` when the BU dashboard's
  // "unbound access in 24h" count for the tenant is zero, meaning
  // every PII read is bound to an active grant. Flipping back to
  // `false` is supported for incident response (e.g. the intake
  // capture flow regressed; ops needs to unblock preauth flows
  // while the regression is fixed).
  async setRequireConsent(input: {
    tenantId: string;
    enabled: boolean;
    actorUserId: string;
  }): Promise<TenantSummary> {
    return this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      const before = await tx.tenant.findUnique({
        where: { id: input.tenantId },
        select: { requireConsent: true },
      });
      if (!before) {
        throw new ValidationFailedError({ tenantId: ['Tenant not found.'] });
      }
      const updated = await tx.tenant.update({
        where: { id: input.tenantId },
        data: { requireConsent: input.enabled },
        select: {
          id: true,
          slug: true,
          displayName: true,
          lifecycleState: true,
          pmjayMode: true,
          requireConsent: true,
        },
      });
      await this.audit.recordWithTx(tx, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        actorType: 'user',
        action: AuditEvents.TENANT_REQUIRE_CONSENT_UPDATED,
        resourceType: 'tenant',
        resourceId: input.tenantId,
        before: { requireConsent: before.requireConsent },
        after: { requireConsent: input.enabled },
      });
      return updated;
    });
  }
}
