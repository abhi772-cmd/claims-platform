import { z } from 'zod';

import { IntegrationMessageSchema } from './integration.schema';

// Stage 9 — cross-claim NHCX status search.
//
// Ops endpoint: GET /admin/nhcx/status-search?correlationId=X
//                                              [&claimRefNum=Y]
//                                              [&preauthRefNum=Z]
//
// All three filters optional but at least one is required (the
// server returns 422 otherwise). Filters compose with AND on the
// integration-message side and OR on the claim-event side because
// claim events store the correlation as a single column and don't
// carry the ref nums directly — those live on the claim row.
//
// Use case: an operator notices a claim stuck mid-flow and wants to
// know what the gateway actually received + sent back. The per-
// claim integration-messages endpoint already exists; this one is
// for the case where the operator only has a correlationId
// (e.g. from a payer phone call) and doesn't yet know which claim
// it belongs to.
//
// Strictly read-only and tenant-scoped (RLS enforces).

export const NhcxStatusSearchQuerySchema = z
  .object({
    correlationId: z.string().min(1).max(128).optional(),
    claimRefNum: z.string().min(1).max(64).optional(),
    preauthRefNum: z.string().min(1).max(64).optional(),
  })
  .refine(
    (v) => Boolean(v.correlationId || v.claimRefNum || v.preauthRefNum),
    {
      message:
        'At least one of correlationId, claimRefNum, preauthRefNum is required.',
    },
  );
export type NhcxStatusSearchQuery = z.infer<typeof NhcxStatusSearchQuerySchema>;

// Slimmer ClaimEvent shape — the full audit row carries a payload Json
// that can be large; we surface only the fields an ops user needs to
// reconstruct the timeline.
export const NhcxStatusSearchEventSchema = z.object({
  id: z.string().uuid(),
  claimId: z.string().uuid(),
  eventType: z.string(),
  resultingStatus: z.string(),
  occurredAt: z.string().datetime(),
  correlationId: z.string().nullable(),
});
export type NhcxStatusSearchEvent = z.infer<typeof NhcxStatusSearchEventSchema>;

// One row per matched claim — its identity + the current claim/case
// status so the operator can decide whether to drive a manual
// transition or wait for the gateway to recover.
export const NhcxStatusSearchClaimSchema = z.object({
  claimId: z.string().uuid(),
  caseId: z.string().uuid(),
  status: z.string(),
  preauthRefNum: z.string().nullable(),
  claimRefNum: z.string().nullable(),
  payerRefNum: z.string().nullable(),
});
export type NhcxStatusSearchClaim = z.infer<typeof NhcxStatusSearchClaimSchema>;

export const NhcxStatusSearchResponseSchema = z.object({
  // Echo of the validated query so the response is self-describing.
  query: z.object({
    correlationId: z.string().nullable(),
    claimRefNum: z.string().nullable(),
    preauthRefNum: z.string().nullable(),
  }),
  integrationMessages: z.array(IntegrationMessageSchema),
  claimEvents: z.array(NhcxStatusSearchEventSchema),
  claims: z.array(NhcxStatusSearchClaimSchema),
});
export type NhcxStatusSearchResponse = z.infer<typeof NhcxStatusSearchResponseSchema>;
