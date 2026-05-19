import {
  type BillingCode,
  type ChecklistAdmissionType,
  type ChecklistPhase,
  type CreateDocumentChecklistRuleRequest,
  type CreatePackageRequest,
  type CreatePayerRequest,
  type DocumentChecklistRule,
  type DocumentType,
  type IcdCode,
  type Package,
  type Payer,
  type PayerRail,
  type PayerType,
  type ResolvedChecklistItem,
  type UpdateDocumentChecklistRuleRequest,
  type UpdatePackageRequest,
  type UpdatePayerRequest,
} from '@claims/contracts';
import { Injectable } from '@nestjs/common';

import { ValidationFailedError } from '../../common/errors/validation-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { type TenantPrisma } from '../../types/express';

// Master data is platform-level (no tenantId column on the rows
// themselves) but RLS still requires SOME role GUC to satisfy the
// SELECT policy. We pass the caller's tenantId for the GUC binding;
// the role determines what's allowed:
//   * 'tenant'         → read-only
//   * 'platform_admin' → read + mutate
const PLATFORM_TENANT = '00000000-0000-0000-0000-000000000000';

export interface ReadCtx {
  tenantId: string;
  role: 'tenant' | 'platform_admin';
}

export interface ListPayersInput {
  rail?: PayerRail;
  active?: boolean;
  limit?: number;
  offset?: number;
}

export interface ListPackagesInput {
  category?: string;
  pmjayHbp?: boolean;
  active?: boolean;
  limit?: number;
  offset?: number;
}

export interface ListIcdInput {
  q?: string;
  active?: boolean;
  limit?: number;
  offset?: number;
}

export interface ListBillingInput {
  category?: string;
  active?: boolean;
  limit?: number;
  offset?: number;
}

export interface ListChecklistRulesInput {
  phase?: ChecklistPhase;
  rail?: PayerRail;
  active?: boolean;
}

export interface ResolveChecklistInput {
  phase: ChecklistPhase;
  rail: PayerRail;
  payerCode?: string;
  packageCode?: string;
  admissionType?: ChecklistAdmissionType;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const clampLimit = (n?: number): number =>
  n === undefined ? DEFAULT_LIMIT : Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)));
const clampOffset = (n?: number): number => Math.max(0, Math.floor(n ?? 0));

@Injectable()
export class MasterDataService {
  constructor(private readonly prisma: PrismaService) {}

  private read<T>(ctx: ReadCtx, cb: (tx: TenantPrisma) => Promise<T>): Promise<T> {
    return this.prisma.runInTenantContext(ctx.tenantId, ctx.role, cb);
  }

  private write<T>(cb: (tx: TenantPrisma) => Promise<T>): Promise<T> {
    return this.prisma.runInTenantContext(PLATFORM_TENANT, 'platform_admin', cb);
  }

  // ---- Payer -----------------------------------------------------

  async listPayers(
    ctx: ReadCtx,
    input: ListPayersInput,
  ): Promise<{ payers: Payer[]; total: number }> {
    const where: { rail?: PayerRail; active?: boolean } = {};
    if (input.rail) where.rail = input.rail;
    if (input.active !== undefined) where.active = input.active;
    const limit = clampLimit(input.limit);
    const offset = clampOffset(input.offset);

    return this.read(ctx, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.payer.findMany({
          where,
          orderBy: { code: 'asc' },
          take: limit,
          skip: offset,
        }),
        tx.payer.count({ where }),
      ]);
      return { payers: rows.map(toPayer), total };
    });
  }

  async getPayer(ctx: ReadCtx, id: string): Promise<Payer | null> {
    const row = await this.read(ctx, (tx) => tx.payer.findUnique({ where: { id } }));
    return row ? toPayer(row) : null;
  }

  async getPayerByCode(ctx: ReadCtx, code: string): Promise<Payer | null> {
    const row = await this.read(ctx, (tx) => tx.payer.findUnique({ where: { code } }));
    return row ? toPayer(row) : null;
  }

  async createPayer(body: CreatePayerRequest): Promise<Payer> {
    const row = await this.write(async (tx) => {
      const existing = await tx.payer.findUnique({ where: { code: body.code } });
      if (existing) {
        throw new ValidationFailedError({ code: ['Payer with this code already exists.'] });
      }
      return tx.payer.create({
        data: {
          code: body.code,
          name: body.name,
          payerType: body.payerType,
          rail: body.rail,
          ...(body.hcxCode !== undefined ? { hcxCode: body.hcxCode } : {}),
          ...(body.effectiveFrom !== undefined
            ? { effectiveFrom: new Date(body.effectiveFrom) }
            : {}),
          ...(body.effectiveTo !== undefined
            ? { effectiveTo: new Date(body.effectiveTo) }
            : {}),
        },
      });
    });
    return toPayer(row);
  }

  async updatePayer(id: string, body: UpdatePayerRequest): Promise<Payer> {
    const row = await this.write(async (tx) => {
      const existing = await tx.payer.findUnique({ where: { id } });
      if (!existing) {
        throw new ValidationFailedError({ id: ['Payer not found.'] });
      }
      return tx.payer.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.payerType !== undefined ? { payerType: body.payerType } : {}),
          ...(body.rail !== undefined ? { rail: body.rail } : {}),
          ...(body.hcxCode !== undefined ? { hcxCode: body.hcxCode } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
          ...(body.effectiveTo !== undefined
            ? { effectiveTo: body.effectiveTo === null ? null : new Date(body.effectiveTo) }
            : {}),
        },
      });
    });
    return toPayer(row);
  }

  // ---- Package ---------------------------------------------------

  async listPackages(
    ctx: ReadCtx,
    input: ListPackagesInput,
  ): Promise<{ packages: Package[]; total: number }> {
    const where: { category?: string; pmjayHbp?: boolean; active?: boolean } = {};
    if (input.category) where.category = input.category;
    if (input.pmjayHbp !== undefined) where.pmjayHbp = input.pmjayHbp;
    if (input.active !== undefined) where.active = input.active;
    const limit = clampLimit(input.limit);
    const offset = clampOffset(input.offset);

    return this.read(ctx, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.package.findMany({
          where,
          orderBy: { code: 'asc' },
          take: limit,
          skip: offset,
        }),
        tx.package.count({ where }),
      ]);
      return { packages: rows.map(toPackage), total };
    });
  }

  async getPackageByCode(ctx: ReadCtx, code: string): Promise<Package | null> {
    const row = await this.read(ctx, (tx) => tx.package.findUnique({ where: { code } }));
    return row ? toPackage(row) : null;
  }

  async createPackage(body: CreatePackageRequest): Promise<Package> {
    const row = await this.write(async (tx) => {
      const existing = await tx.package.findUnique({ where: { code: body.code } });
      if (existing) {
        throw new ValidationFailedError({ code: ['Package with this code already exists.'] });
      }
      return tx.package.create({
        data: {
          code: body.code,
          name: body.name,
          ...(body.category !== undefined ? { category: body.category } : {}),
          amount: body.amount,
          ...(body.pmjayHbp !== undefined ? { pmjayHbp: body.pmjayHbp } : {}),
          ...(body.effectiveFrom !== undefined
            ? { effectiveFrom: new Date(body.effectiveFrom) }
            : {}),
          ...(body.effectiveTo !== undefined ? { effectiveTo: new Date(body.effectiveTo) } : {}),
        },
      });
    });
    return toPackage(row);
  }

  async updatePackage(id: string, body: UpdatePackageRequest): Promise<Package> {
    const row = await this.write(async (tx) => {
      const existing = await tx.package.findUnique({ where: { id } });
      if (!existing) {
        throw new ValidationFailedError({ id: ['Package not found.'] });
      }
      return tx.package.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.category !== undefined ? { category: body.category } : {}),
          ...(body.amount !== undefined ? { amount: body.amount } : {}),
          ...(body.pmjayHbp !== undefined ? { pmjayHbp: body.pmjayHbp } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
          ...(body.effectiveTo !== undefined
            ? { effectiveTo: body.effectiveTo === null ? null : new Date(body.effectiveTo) }
            : {}),
        },
      });
    });
    return toPackage(row);
  }

  // ---- ICD code --------------------------------------------------

  async listIcd(
    ctx: ReadCtx,
    input: ListIcdInput,
  ): Promise<{ codes: IcdCode[]; total: number }> {
    const where: {
      active?: boolean;
      OR?: Array<
        | { code: { contains: string; mode: 'insensitive' } }
        | { description: { contains: string; mode: 'insensitive' } }
      >;
    } = {};
    if (input.active !== undefined) where.active = input.active;
    if (input.q && input.q.length > 0) {
      where.OR = [
        { code: { contains: input.q, mode: 'insensitive' } },
        { description: { contains: input.q, mode: 'insensitive' } },
      ];
    }
    const limit = clampLimit(input.limit);
    const offset = clampOffset(input.offset);

    return this.read(ctx, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.icdCode.findMany({
          where,
          orderBy: { code: 'asc' },
          take: limit,
          skip: offset,
        }),
        tx.icdCode.count({ where }),
      ]);
      return { codes: rows.map(toIcd), total };
    });
  }

  // ---- Billing code ---------------------------------------------

  async listBilling(
    ctx: ReadCtx,
    input: ListBillingInput,
  ): Promise<{ codes: BillingCode[]; total: number }> {
    const where: { category?: string; active?: boolean } = {};
    if (input.category) where.category = input.category;
    if (input.active !== undefined) where.active = input.active;
    const limit = clampLimit(input.limit);
    const offset = clampOffset(input.offset);

    return this.read(ctx, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.billingCode.findMany({
          where,
          orderBy: { code: 'asc' },
          take: limit,
          skip: offset,
        }),
        tx.billingCode.count({ where }),
      ]);
      return { codes: rows.map(toBilling), total };
    });
  }

  // ---- Document checklist rule ----------------------------------

  async listChecklistRules(
    ctx: ReadCtx,
    input: ListChecklistRulesInput,
  ): Promise<{ rules: DocumentChecklistRule[]; total: number }> {
    const where: { phase?: ChecklistPhase; rail?: PayerRail; active?: boolean } = {};
    if (input.phase) where.phase = input.phase;
    if (input.rail) where.rail = input.rail;
    if (input.active !== undefined) where.active = input.active;

    return this.read(ctx, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.documentChecklistRule.findMany({
          where,
          orderBy: [{ phase: 'asc' }, { documentType: 'asc' }],
        }),
        tx.documentChecklistRule.count({ where }),
      ]);
      return { rules: rows.map(toChecklistRule), total };
    });
  }

  async createChecklistRule(
    body: CreateDocumentChecklistRuleRequest,
  ): Promise<DocumentChecklistRule> {
    const row = await this.write((tx) =>
      tx.documentChecklistRule.create({
        data: {
          phase: body.phase,
          rail: body.rail,
          documentType: body.documentType,
          ...(body.required !== undefined ? { required: body.required } : {}),
          ...(body.payerCode !== undefined ? { payerCode: body.payerCode } : {}),
          ...(body.packageCode !== undefined ? { packageCode: body.packageCode } : {}),
          ...(body.admissionType !== undefined ? { admissionType: body.admissionType } : {}),
          ...(body.conditions !== undefined ? { conditions: body.conditions as never } : {}),
          ...(body.effectiveFrom !== undefined
            ? { effectiveFrom: new Date(body.effectiveFrom) }
            : {}),
          ...(body.effectiveTo !== undefined ? { effectiveTo: new Date(body.effectiveTo) } : {}),
        },
      }),
    );
    return toChecklistRule(row);
  }

  async updateChecklistRule(
    id: string,
    body: UpdateDocumentChecklistRuleRequest,
  ): Promise<DocumentChecklistRule> {
    const row = await this.write(async (tx) => {
      const existing = await tx.documentChecklistRule.findUnique({ where: { id } });
      if (!existing) {
        throw new ValidationFailedError({ id: ['Rule not found.'] });
      }
      return tx.documentChecklistRule.update({
        where: { id },
        data: {
          ...(body.required !== undefined ? { required: body.required } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
          ...(body.conditions !== undefined ? { conditions: body.conditions as never } : {}),
          ...(body.effectiveTo !== undefined
            ? { effectiveTo: body.effectiveTo === null ? null : new Date(body.effectiveTo) }
            : {}),
        },
      });
    });
    return toChecklistRule(row);
  }

  // Resolve which document types are required for a given (phase, rail)
  // narrowed by optional payerCode/packageCode/admissionType.
  // Most-specific rule wins per documentType: explicit phase beats 'all',
  // matching payer beats unset payer, etc. Currently-effective rules only
  // — rows with effectiveTo in the past are excluded.
  async resolveChecklist(
    ctx: ReadCtx,
    input: ResolveChecklistInput,
  ): Promise<ResolvedChecklistItem[]> {
    const now = new Date();
    return this.read(ctx, async (tx) => {
      const rules = await tx.documentChecklistRule.findMany({
        where: {
          active: true,
          rail: input.rail,
          OR: [{ phase: input.phase }, { phase: 'all' }],
          AND: [
            { effectiveFrom: { lte: now } },
            { OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
          ],
        },
        orderBy: [{ documentType: 'asc' }, { effectiveFrom: 'desc' }],
      });

      const score = (r: {
        phase: string;
        payerCode: string | null;
        packageCode: string | null;
        admissionType: string | null;
      }): number => {
        let s = 0;
        if (r.phase !== 'all') s += 8;
        if (r.payerCode && input.payerCode && r.payerCode === input.payerCode) s += 4;
        if (r.packageCode && input.packageCode && r.packageCode === input.packageCode) s += 2;
        if (r.admissionType && input.admissionType && r.admissionType === input.admissionType)
          s += 1;
        return s;
      };

      const applies = (r: {
        payerCode: string | null;
        packageCode: string | null;
        admissionType: string | null;
      }): boolean => {
        if (r.payerCode && r.payerCode !== input.payerCode) return false;
        if (r.packageCode && r.packageCode !== input.packageCode) return false;
        if (r.admissionType && r.admissionType !== input.admissionType) return false;
        return true;
      };

      const winners = new Map<string, (typeof rules)[number]>();
      for (const r of rules) {
        if (!applies(r)) continue;
        const prev = winners.get(r.documentType);
        if (!prev || score(r) > score(prev)) winners.set(r.documentType, r);
      }

      return Array.from(winners.values()).map((r) => ({
        documentType: r.documentType as DocumentType,
        required: r.required,
        ruleId: r.id,
      }));
    });
  }
}

// ---- mappers --------------------------------------------------

function toPayer(row: {
  id: string;
  code: string;
  name: string;
  payerType: string;
  rail: string;
  hcxCode: string | null;
  active: boolean;
  supportsDiscoveryByMobile: boolean;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}): Payer {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    payerType: row.payerType as PayerType,
    rail: row.rail as PayerRail,
    hcxCode: row.hcxCode,
    active: row.active,
    supportsDiscoveryByMobile: row.supportsDiscoveryByMobile,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo ? row.effectiveTo.toISOString() : null,
  };
}

function toPackage(row: {
  id: string;
  code: string;
  name: string;
  category: string | null;
  amount: number;
  pmjayHbp: boolean;
  active: boolean;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}): Package {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    category: row.category,
    amount: row.amount,
    pmjayHbp: row.pmjayHbp,
    active: row.active,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo ? row.effectiveTo.toISOString() : null,
  };
}

function toIcd(row: {
  code: string;
  description: string;
  chapter: string | null;
  active: boolean;
}): IcdCode {
  return {
    code: row.code,
    description: row.description,
    chapter: row.chapter,
    active: row.active,
  };
}

function toBilling(row: {
  code: string;
  description: string;
  category: string | null;
  baseAmount: number | null;
  active: boolean;
}): BillingCode {
  return {
    code: row.code,
    description: row.description,
    category: row.category,
    baseAmount: row.baseAmount,
    active: row.active,
  };
}

function toChecklistRule(row: {
  id: string;
  phase: string;
  rail: string;
  documentType: string;
  required: boolean;
  payerCode: string | null;
  packageCode: string | null;
  admissionType: string | null;
  conditions: unknown;
  active: boolean;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}): DocumentChecklistRule {
  return {
    id: row.id,
    phase: row.phase as ChecklistPhase,
    rail: row.rail as PayerRail,
    documentType: row.documentType as DocumentType,
    required: row.required,
    payerCode: row.payerCode,
    packageCode: row.packageCode,
    admissionType: row.admissionType as ChecklistAdmissionType | null,
    conditions:
      typeof row.conditions === 'object' && row.conditions !== null
        ? (row.conditions as Record<string, unknown>)
        : {},
    active: row.active,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo ? row.effectiveTo.toISOString() : null,
  };
}
