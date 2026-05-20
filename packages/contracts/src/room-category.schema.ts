import { z } from 'zod';

// Tenant-scoped room rate catalog + per-payer overrides.
//
// `code` is upper-snake (`GENERAL_WARD`, `ICU`) and unique per tenant.
// `name` and `category` are free text so admins can use whatever
// vocabulary fits the hospital (`ward`, `private deluxe`, `icu`).
// Rates are stored in paise to stay consistent with the rest of the
// platform's money columns.

const PAISE_MAX = 100_000_00; // ₹1L/day ceiling — guards typos on intake.

const ROOM_CATEGORY_CODE = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[A-Z0-9_]+$/, 'Code must be UPPER_SNAKE');

export const RoomCategorySchema = z.object({
  id: z.string().uuid(),
  code: ROOM_CATEGORY_CODE,
  name: z.string().min(1).max(120),
  category: z.string().min(1).max(60),
  dailyRatePaise: z.number().int().nonnegative().max(PAISE_MAX),
  sortOrder: z.number().int(),
  active: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type RoomCategory = z.infer<typeof RoomCategorySchema>;

export const CreateRoomCategoryRequestSchema = z.object({
  code: ROOM_CATEGORY_CODE,
  name: z.string().min(1).max(120),
  category: z.string().min(1).max(60),
  dailyRatePaise: z.number().int().nonnegative().max(PAISE_MAX),
  sortOrder: z.number().int().optional(),
});
export type CreateRoomCategoryRequest = z.infer<typeof CreateRoomCategoryRequestSchema>;

export const UpdateRoomCategoryRequestSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  category: z.string().min(1).max(60).optional(),
  dailyRatePaise: z.number().int().nonnegative().max(PAISE_MAX).optional(),
  sortOrder: z.number().int().optional(),
  active: z.boolean().optional(),
});
export type UpdateRoomCategoryRequest = z.infer<typeof UpdateRoomCategoryRequestSchema>;

// ─── Per-payer override ───────────────────────────────────────────

export const RoomCategoryPayerRateSchema = z.object({
  id: z.string().uuid(),
  roomCategoryId: z.string().uuid(),
  payerCode: z.string().min(1).max(64),
  dailyRatePaise: z.number().int().nonnegative().max(PAISE_MAX),
  active: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type RoomCategoryPayerRate = z.infer<typeof RoomCategoryPayerRateSchema>;

// Upsert by (roomCategoryId, payerCode). No separate POST/PATCH — the
// admin UI saves the whole row at once, and the unique constraint
// makes it idempotent.
export const UpsertRoomCategoryPayerRateRequestSchema = z.object({
  payerCode: z.string().min(1).max(64),
  dailyRatePaise: z.number().int().nonnegative().max(PAISE_MAX),
});
export type UpsertRoomCategoryPayerRateRequest = z.infer<
  typeof UpsertRoomCategoryPayerRateRequestSchema
>;

// ─── List responses ───────────────────────────────────────────────

// Intake-side row: a room category enriched with the resolved rate
// for a given payer (override if present, else default). Returned by
// /room-categories?payerCode=... so the dropdown on /cases/new can
// render `Private · ₹9,500 (Star · default ₹12,000)` without two
// fetches.
export const ResolvedRoomCategorySchema = RoomCategorySchema.extend({
  // The override rate when payerCode is supplied and a row exists.
  // Null when no override (UI falls back to dailyRatePaise).
  payerOverridePaise: z.number().int().nonnegative().max(PAISE_MAX).nullable(),
  // Convenience: dailyRatePaise when override is null, else override.
  effectiveRatePaise: z.number().int().nonnegative().max(PAISE_MAX),
});
export type ResolvedRoomCategory = z.infer<typeof ResolvedRoomCategorySchema>;

export const RoomCategoryListResponseSchema = z.object({
  categories: z.array(ResolvedRoomCategorySchema),
});
export type RoomCategoryListResponse = z.infer<typeof RoomCategoryListResponseSchema>;

export const RoomCategoryPayerRateListResponseSchema = z.object({
  rates: z.array(RoomCategoryPayerRateSchema),
});
export type RoomCategoryPayerRateListResponse = z.infer<
  typeof RoomCategoryPayerRateListResponseSchema
>;
