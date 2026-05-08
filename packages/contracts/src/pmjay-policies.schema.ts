// Slice BJ — PMJAY beneficiary policies lookup. Pre-eligibility step
// where the operator enters an ABHA / mobile and the API returns the
// list of PMJAY policies the beneficiary is enrolled in, so the
// operator can pick one before running eligibility. PMJAY-only —
// the API rejects calls from non-PMJAY tenants at the service gate.

import { z } from 'zod';

// ABHA: 14 digits, no hyphens (per the PMJAY supporting docs).
// Mobile: Indian 10-digit format (no leading +91 / 0).
//
// We keep the regex strict here so a malformed identifier fails at
// the validation pipe before reaching the adapter — saves a network
// round-trip and gives the frontend a clean field-targeted error.
const AbhaPattern = /^\d{14}$/;
const MobilePattern = /^\d{10}$/;

export const PmjayPolicyLookupRequestSchema = z
  .object({
    identifierType: z.enum(['abha', 'mobile']),
    identifier: z.string().min(1).max(64),
  })
  .superRefine((val, ctx) => {
    if (val.identifierType === 'abha' && !AbhaPattern.test(val.identifier)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['identifier'],
        message: 'ABHA must be 14 digits without hyphens.',
      });
    }
    if (val.identifierType === 'mobile' && !MobilePattern.test(val.identifier)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['identifier'],
        message: 'Mobile must be 10 digits.',
      });
    }
  });
export type PmjayPolicyLookupRequest = z.infer<typeof PmjayPolicyLookupRequestSchema>;

export const PmjayPolicySchema = z.object({
  payerId: z.string(),
  memberId: z.string(),
  productId: z.string(),
  productName: z.string(),
  policyNumber: z.string(),
});
export type PmjayPolicy = z.infer<typeof PmjayPolicySchema>;

export const PmjayPolicyLookupResponseSchema = z.object({
  policies: z.array(PmjayPolicySchema),
  identifierType: z.enum(['abha', 'mobile']),
  identifier: z.string(),
});
export type PmjayPolicyLookupResponse = z.infer<typeof PmjayPolicyLookupResponseSchema>;
