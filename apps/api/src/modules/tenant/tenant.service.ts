import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';

interface TenantSummary {
  id: string;
  slug: string;
  displayName: string;
  lifecycleState: string;
  // Slice BG — 'on' = PMJAY-via-NHCX flow active; preauth + claim
  // submit gate on biometric verification. 'off' (default) skips
  // the gate.
  pmjayMode: string;
}

@Injectable()
export class TenantService {
  constructor(private readonly prisma: PrismaService) {}

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
        select: { id: true, slug: true, displayName: true, lifecycleState: true, pmjayMode: true },
      }),
    );
  }

  async findBySlug(slug: string): Promise<TenantSummary | null> {
    // Slug → id resolution can't pre-set the tenant context (we don't
    // know the id yet). No call site today; if a caller appears, route
    // it through a platform-admin-scoped runInTenantContext.
    return this.prisma.tenant.findUnique({
      where: { slug },
      select: { id: true, slug: true, displayName: true, lifecycleState: true, pmjayMode: true },
    });
  }
}
