// Tenant-scoped room rate catalog + per-payer overrides.
//
// The catalog is the source of truth for the room rate the intake
// operator picks at /cases/new. When a payer is chosen, intake fetches
// the resolved list (default + override + effective rate per row in
// one shot) so the dropdown can render `Private · ₹9,500 (Star ·
// default ₹12,000)` without two roundtrips.
//
// All writes happen through TENANT_ONBOARDING_UPDATE because the
// catalog is part of the per-payer commercial terms captured at
// onboarding. Reads use CASE_CREATE — every intake operator needs to
// see the catalog.

import {
  type ResolvedRoomCategory,
  type RoomCategory,
  type RoomCategoryPayerRate,
} from '@claims/contracts';
import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';

export interface CreateRoomCategoryInput {
  code: string;
  name: string;
  category: string;
  dailyRatePaise: number;
  sortOrder?: number;
}

export interface UpdateRoomCategoryInput {
  name?: string;
  category?: string;
  dailyRatePaise?: number;
  sortOrder?: number;
  active?: boolean;
}

export interface UpsertPayerRateInput {
  payerCode: string;
  dailyRatePaise: number;
}

@Injectable()
export class RoomCategoryService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------

  // Intake-facing list. When `payerCode` is supplied we left-join the
  // override table so the response includes the effective rate per
  // category. When omitted, every row's payerOverridePaise is null
  // and effectiveRatePaise equals dailyRatePaise.
  async listResolved(
    tenantId: string,
    payerCode: string | null,
  ): Promise<ResolvedRoomCategory[]> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const categories = await tx.roomCategory.findMany({
        where: { tenantId, active: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      });

      const overrides =
        payerCode === null
          ? []
          : await tx.roomCategoryPayerRate.findMany({
              where: {
                tenantId,
                payerCode,
                active: true,
                roomCategoryId: { in: categories.map((c) => c.id) },
              },
            });
      const byCategoryId = new Map(overrides.map((o) => [o.roomCategoryId, o]));

      return categories.map((c) => {
        const override = byCategoryId.get(c.id) ?? null;
        return {
          id: c.id,
          code: c.code,
          name: c.name,
          category: c.category,
          dailyRatePaise: c.dailyRatePaise,
          sortOrder: c.sortOrder,
          active: c.active,
          createdAt: c.createdAt.toISOString(),
          updatedAt: c.updatedAt.toISOString(),
          payerOverridePaise: override?.dailyRatePaise ?? null,
          effectiveRatePaise: override?.dailyRatePaise ?? c.dailyRatePaise,
        };
      });
    });
  }

  // Admin-facing list — every row including deactivated; no
  // override join (the admin UI manages overrides per-row).
  async listAll(tenantId: string): Promise<RoomCategory[]> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const rows = await tx.roomCategory.findMany({
        where: { tenantId },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      });
      return rows.map(toRoomCategory);
    });
  }

  async listPayerRates(
    tenantId: string,
    roomCategoryId: string,
  ): Promise<RoomCategoryPayerRate[]> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const category = await tx.roomCategory.findFirst({
        where: { id: roomCategoryId, tenantId },
        select: { id: true },
      });
      if (!category) throw new NotFoundException('Room category not found.');
      const rows = await tx.roomCategoryPayerRate.findMany({
        where: { tenantId, roomCategoryId },
        orderBy: { payerCode: 'asc' },
      });
      return rows.map(toPayerRate);
    });
  }

  // ---------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------

  async create(tenantId: string, input: CreateRoomCategoryInput): Promise<RoomCategory> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const row = await tx.roomCategory.create({
        data: {
          tenantId,
          code: input.code,
          name: input.name,
          category: input.category,
          dailyRatePaise: input.dailyRatePaise,
          sortOrder: input.sortOrder ?? 0,
        },
      });
      return toRoomCategory(row);
    });
  }

  async update(
    tenantId: string,
    id: string,
    input: UpdateRoomCategoryInput,
  ): Promise<RoomCategory> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const existing = await tx.roomCategory.findFirst({
        where: { id, tenantId },
      });
      if (!existing) throw new NotFoundException('Room category not found.');
      const row = await tx.roomCategory.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
          ...(input.dailyRatePaise !== undefined
            ? { dailyRatePaise: input.dailyRatePaise }
            : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
      });
      return toRoomCategory(row);
    });
  }

  // Soft-delete via active=false. Hard delete would cascade-drop the
  // override rows and any case captured against this category would
  // lose its audit context. Mark inactive so the catalog stops
  // surfacing it on intake but historical references stay intact.
  async deactivate(tenantId: string, id: string): Promise<RoomCategory> {
    return this.update(tenantId, id, { active: false });
  }

  async upsertPayerRate(
    tenantId: string,
    roomCategoryId: string,
    input: UpsertPayerRateInput,
  ): Promise<RoomCategoryPayerRate> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const category = await tx.roomCategory.findFirst({
        where: { id: roomCategoryId, tenantId },
        select: { id: true },
      });
      if (!category) throw new NotFoundException('Room category not found.');

      const existing = await tx.roomCategoryPayerRate.findFirst({
        where: {
          tenantId,
          roomCategoryId,
          payerCode: input.payerCode,
        },
      });
      const row = existing
        ? await tx.roomCategoryPayerRate.update({
            where: { id: existing.id },
            data: {
              dailyRatePaise: input.dailyRatePaise,
              active: true,
            },
          })
        : await tx.roomCategoryPayerRate.create({
            data: {
              tenantId,
              roomCategoryId,
              payerCode: input.payerCode,
              dailyRatePaise: input.dailyRatePaise,
            },
          });
      return toPayerRate(row);
    });
  }

  async deletePayerRate(
    tenantId: string,
    roomCategoryId: string,
    payerCode: string,
  ): Promise<void> {
    await this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const existing = await tx.roomCategoryPayerRate.findFirst({
        where: { tenantId, roomCategoryId, payerCode },
      });
      if (!existing) throw new NotFoundException('Payer rate not found.');
      await tx.roomCategoryPayerRate.delete({ where: { id: existing.id } });
    });
  }
}

// Prisma → contract projections.

function toRoomCategory(row: {
  id: string;
  code: string;
  name: string;
  category: string;
  dailyRatePaise: number;
  sortOrder: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}): RoomCategory {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    category: row.category,
    dailyRatePaise: row.dailyRatePaise,
    sortOrder: row.sortOrder,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toPayerRate(row: {
  id: string;
  roomCategoryId: string;
  payerCode: string;
  dailyRatePaise: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}): RoomCategoryPayerRate {
  return {
    id: row.id,
    roomCategoryId: row.roomCategoryId,
    payerCode: row.payerCode,
    dailyRatePaise: row.dailyRatePaise,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
