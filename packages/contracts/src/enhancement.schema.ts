import { z } from 'zod';

// T2-8 — preauth enhancement.
//
// Triggered when a patient is moved to a higher-tier ward mid-stay
// (most commonly: ward → ICU) and the originally approved preauth
// amount is now insufficient. NHCX treats this as a follow-up
// preauth/submit referencing the prior approval; we model it as a
// distinct state-machine phase (ENHANCEMENT_DRAFTING →
// ENHANCEMENT_QUEUED → ENHANCEMENT_SUBMITTED → ENHANCEMENT_APPROVED
// / ENHANCEMENT_REJECTED) so the operator UI can drive each phase
// explicitly. The state machine itself is already defined in
// apps/api/src/modules/claim/claim.state-machine.ts.
//
// Two endpoints:
//   POST /cases/:c/claims/:cl/enhancement/start    — flips into ENHANCEMENT_DRAFTING
//   POST /cases/:c/claims/:cl/enhancement/submit   — { revisedAmount, reason } → ENHANCEMENT_QUEUED

// State-only transition; body is empty.
export const EnhancementStartRequestSchema = z.object({});
export type EnhancementStartRequest = z.infer<typeof EnhancementStartRequestSchema>;

export const EnhancementSubmitRequestSchema = z.object({
  // The new TOTAL preauth amount the hospital is asking for
  // (paise). NOT the delta. Same convention as preauth's
  // requestedAmount. Cap at ₹50 lakh to catch typos that would
  // otherwise hit the gateway with a sentence-length number.
  revisedAmount: z.number().int().positive().max(50_00_00_000),
  // Free-form operator justification — surfaced to the payer on
  // the FHIR Communication side note attached to the enhancement
  // bundle. 2000-char ceiling matches PreauthDecision.
  reason: z.string().min(1).max(2000),
});
export type EnhancementSubmitRequest = z.infer<typeof EnhancementSubmitRequestSchema>;

export const EnhancementResponseSchema = z.object({
  status: z.string(),
  payerRefNum: z.string().nullable(),
  correlationId: z.string().nullable(),
});
export type EnhancementResponse = z.infer<typeof EnhancementResponseSchema>;
