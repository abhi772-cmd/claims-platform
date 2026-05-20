// Slice CN — tenant ↔ payer empanelment contracts.
//
// The platform `payer` table is a superadmin-curated registry. A
// tenant empanels (ties up with) a subset of those payers; the
// empanelled set drives the case-creation payer dropdown. This file
// types the tenant-facing empanelment surface:
//
//   GET   /tenant/payers            → empanelled payers (active by default)
//   GET   /tenant/payers/available  → full registry + an `empanelled` flag
//   POST  /tenant/payers            → empanel a registry payer
//   PATCH /tenant/payers/:payerId   → toggle active (retire / re-activate)

import { z } from 'zod';

import { PayerRailSchema, PayerTypeSchema } from './master-data.schema';

// An empanelled payer, flattened from the join row + its registry
// payer. This is what the case dropdown consumes — it never needs the
// raw join id, just the payer identity + the active flag.
export const EmpanelledPayerSchema = z.object({
  payerId: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  payerType: PayerTypeSchema,
  rail: PayerRailSchema,
  hcxCode: z.string().nullable(),
  // Carried from the registry row so the case-creation identity widget
  // can gate the discover-by-mobile picker without a second fetch.
  supportsDiscoveryByMobile: z.boolean(),
  active: z.boolean(),
  empanelledAt: z.string(),
});
export type EmpanelledPayer = z.infer<typeof EmpanelledPayerSchema>;

export const EmpanelledPayerListResponseSchema = z.object({
  payers: z.array(EmpanelledPayerSchema),
});
export type EmpanelledPayerListResponse = z.infer<typeof EmpanelledPayerListResponseSchema>;

// Registry payer + whether THIS tenant has empanelled it. Powers the
// empanelment picker (show every registry payer with a tick where
// already selected).
export const AvailablePayerSchema = z.object({
  payerId: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  payerType: PayerTypeSchema,
  rail: PayerRailSchema,
  hcxCode: z.string().nullable(),
  // True when the tenant already has a tenant_payer row (regardless of
  // its active flag — `empanelledActive` disambiguates).
  empanelled: z.boolean(),
  empanelledActive: z.boolean(),
});
export type AvailablePayer = z.infer<typeof AvailablePayerSchema>;

export const AvailablePayerListResponseSchema = z.object({
  payers: z.array(AvailablePayerSchema),
});
export type AvailablePayerListResponse = z.infer<typeof AvailablePayerListResponseSchema>;

export const EmpanelPayerRequestSchema = z.object({
  payerId: z.string().uuid(),
});
export type EmpanelPayerRequest = z.infer<typeof EmpanelPayerRequestSchema>;

export const SetEmpanelmentActiveRequestSchema = z.object({
  active: z.boolean(),
});
export type SetEmpanelmentActiveRequest = z.infer<typeof SetEmpanelmentActiveRequestSchema>;
