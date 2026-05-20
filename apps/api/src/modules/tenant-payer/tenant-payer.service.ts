// Slice CN — tenant ↔ payer empanelment service.
//
// The `payer` table is a platform-curated registry (superadmin-only
// edits). This service is the tenant-facing layer: a tenant empanels
// (ties up with) a subset of registry payers, and the empanelled set
// drives the case-creation payer dropdown.
//
// Reads run under the tenant RLS context — `tenant_payer` rows are
// tenant-scoped, and the `payer` registry is readable (read-only) by
// the tenant role, so both queries succeed in one context. There's no
// Prisma relation between the two (the FK lives at the SQL level), so
// we merge by payerId in code.

import {
  type AvailablePayer,
  type EmpanelledPayer,
  type PayerRail,
  type PayerType,
} from '@claims/contracts';
import { Injectable } from '@nestjs/common';

import { ValidationFailedError } from '../../common/errors/validation-errors';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class TenantPayerService {
  constructor(private readonly prisma: PrismaService) {}

  // Empanelled payers for the case dropdown. activeOnly=true (default)
  // hides retired empanelments; the empanelment admin page passes
  // false to show retired rows too.
  async listEmpanelled(tenantId: string, activeOnly = true): Promise<EmpanelledPayer[]> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const links = await tx.tenantPayer.findMany({
        where: { tenantId, ...(activeOnly ? { active: true } : {}) },
        orderBy: { empanelledAt: 'desc' },
      });
      if (links.length === 0) return [];
      const payers = await tx.payer.findMany({
        where: { id: { in: links.map((l) => l.payerId) } },
      });
      const payerById = new Map(payers.map((p) => [p.id, p]));
      return links
        .map((l): EmpanelledPayer | null => {
          const p = payerById.get(l.payerId);
          if (!p) return null;
          return {
            payerId: p.id,
            code: p.code,
            name: p.name,
            payerType: p.payerType as PayerType,
            rail: p.rail as PayerRail,
            hcxCode: p.hcxCode,
            supportsDiscoveryByMobile: p.supportsDiscoveryByMobile,
            active: l.active,
            empanelledAt: l.empanelledAt.toISOString(),
          };
        })
        .filter((x): x is EmpanelledPayer => x !== null);
    });
  }

  // Full registry annotated with whether THIS tenant has empanelled
  // each payer. Powers the picker. Self-pay payers are excluded —
  // they're not something a hospital "empanels" with.
  async listAvailable(tenantId: string): Promise<AvailablePayer[]> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const [payers, links] = await Promise.all([
        tx.payer.findMany({
          where: { active: true, rail: { not: 'self_pay' } },
          orderBy: { name: 'asc' },
        }),
        tx.tenantPayer.findMany({ where: { tenantId } }),
      ]);
      const linkByPayer = new Map(links.map((l) => [l.payerId, l]));
      return payers.map((p): AvailablePayer => {
        const link = linkByPayer.get(p.id);
        return {
          payerId: p.id,
          code: p.code,
          name: p.name,
          payerType: p.payerType as PayerType,
          rail: p.rail as PayerRail,
          hcxCode: p.hcxCode,
          empanelled: link !== undefined,
          empanelledActive: link?.active ?? false,
        };
      });
    });
  }

  // Empanel a registry payer. Idempotent: re-empanelling an existing
  // (possibly retired) link flips it back to active rather than
  // erroring. Validates the payer exists + isn't self-pay.
  async empanel(tenantId: string, payerId: string): Promise<EmpanelledPayer> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const payer = await tx.payer.findUnique({ where: { id: payerId } });
      if (!payer || !payer.active) {
        throw new ValidationFailedError({ payerId: ['Payer not found in the registry.'] });
      }
      if (payer.rail === 'self_pay') {
        throw new ValidationFailedError({
          payerId: ['Self-pay is not an empanellable payer.'],
        });
      }
      const link = await tx.tenantPayer.upsert({
        where: { tenantId_payerId: { tenantId, payerId } },
        create: { tenantId, payerId, active: true },
        update: { active: true },
      });
      return {
        payerId: payer.id,
        code: payer.code,
        name: payer.name,
        payerType: payer.payerType as PayerType,
        rail: payer.rail as PayerRail,
        hcxCode: payer.hcxCode,
        supportsDiscoveryByMobile: payer.supportsDiscoveryByMobile,
        active: link.active,
        empanelledAt: link.empanelledAt.toISOString(),
      };
    });
  }

  // Retire (active=false) or re-activate an empanelment without
  // deleting the row — preserves history for audit / past cases.
  async setActive(tenantId: string, payerId: string, active: boolean): Promise<EmpanelledPayer> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const existing = await tx.tenantPayer.findUnique({
        where: { tenantId_payerId: { tenantId, payerId } },
      });
      if (!existing) {
        throw new ValidationFailedError({
          payerId: ['This payer is not empanelled for the tenant.'],
        });
      }
      const link = await tx.tenantPayer.update({
        where: { tenantId_payerId: { tenantId, payerId } },
        data: { active },
      });
      const payer = await tx.payer.findUnique({ where: { id: payerId } });
      if (!payer) {
        throw new ValidationFailedError({ payerId: ['Payer not found in the registry.'] });
      }
      return {
        payerId: payer.id,
        code: payer.code,
        name: payer.name,
        payerType: payer.payerType as PayerType,
        rail: payer.rail as PayerRail,
        hcxCode: payer.hcxCode,
        supportsDiscoveryByMobile: payer.supportsDiscoveryByMobile,
        active: link.active,
        empanelledAt: link.empanelledAt.toISOString(),
      };
    });
  }
}
