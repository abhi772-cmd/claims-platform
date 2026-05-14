import {
  type TenantProfile,
  type TenantProfileUpdate,
} from '@claims/contracts';
import { Injectable } from '@nestjs/common';

import { TenantNotFoundError } from '../../common/errors/tenant-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditEvents, AuditService } from '../audit';

export interface UpdateTenantProfileInput {
  tenantId: string;
  actorUserId: string;
  patch: TenantProfileUpdate;
  ip: string | null;
  userAgent: string | null;
}

// Stage-1 onboarding profile read/write (docs/15). Fields are all
// nullable on the row — GET returns the current values (nulls
// included), PATCH does a sparse update where `undefined` keys are
// left untouched and explicit `null` clears the column.
@Injectable()
export class TenantProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(tenantId: string): Promise<TenantProfile> {
    const row = await this.prisma.runInTenantContext(tenantId, 'tenant', (tx) =>
      tx.tenant.findUnique({
        where: { id: tenantId },
        select: {
          legalName: true,
          rohiniId: true,
          hospitalType: true,
          bedCount: true,
          hmisVendor: true,
          expectedMonthlyClaimsBand: true,
        },
      }),
    );
    if (!row) {
      throw new TenantNotFoundError();
    }
    return row;
  }

  async update(input: UpdateTenantProfileInput): Promise<TenantProfile> {
    return this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      const before = await tx.tenant.findUnique({
        where: { id: input.tenantId },
        select: {
          legalName: true,
          rohiniId: true,
          hospitalType: true,
          bedCount: true,
          hmisVendor: true,
          expectedMonthlyClaimsBand: true,
        },
      });
      if (!before) {
        throw new TenantNotFoundError();
      }
      const after = await tx.tenant.update({
        where: { id: input.tenantId },
        data: input.patch,
        select: {
          legalName: true,
          rohiniId: true,
          hospitalType: true,
          bedCount: true,
          hmisVendor: true,
          expectedMonthlyClaimsBand: true,
        },
      });
      await this.audit.recordWithTx(tx, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        actorType: 'user',
        action: AuditEvents.TENANT_UPDATED,
        resourceType: 'tenant_profile',
        resourceId: input.tenantId,
        before,
        after,
        ipAddress: input.ip,
        userAgent: input.userAgent,
      });
      return after;
    });
  }
}
