// Phase 2 — ABDM ABHA creation via Aadhaar OTP. Public wire shapes
// for the two-step flow:
//
//   POST /abha/init    Aadhaar → ABDM sends OTP to registered mobile
//   POST /abha/verify  OTP    → ABDM returns a fresh ABHA + healthId
//
// The actual ABDM endpoints are
// /v3/profile/account/aadhaar/sendOtp and /verifyOtp — adapter
// implementations translate to those at the wire level.

import { z } from 'zod';

const AADHAAR_PATTERN = /^\d{12}$/;
const OTP_PATTERN = /^\d{6}$/;

export const AbhaCreateInitRequestSchema = z.object({
  // Aadhaar must be 12 digits, no spaces / hyphens. The strict
  // pattern keeps malformed values out of the ABDM call.
  aadhaar: z.string().regex(AADHAAR_PATTERN, 'Aadhaar must be 12 digits.'),
});
export type AbhaCreateInitRequest = z.infer<typeof AbhaCreateInitRequestSchema>;

export const AbhaCreateInitResponseSchema = z.object({
  // Opaque token returned by ABDM that the verify call must echo
  // back. Operators don't see it — the UI threads it via state.
  txnId: z.string().min(1),
  // Masked mobile (e.g. "XXXXXX1234") shown to the operator so they
  // can tell the patient which mobile the OTP will land on.
  mobileMasked: z.string().min(1),
  // ABDM occasionally returns the Aadhaar-registered full name on
  // sendOtp so the UI can confirm to the operator that the Aadhaar
  // matches the human they captured. Optional — not all ABDM
  // versions populate it.
  fullNameHint: z.string().optional(),
});
export type AbhaCreateInitResponse = z.infer<typeof AbhaCreateInitResponseSchema>;

export const AbhaCreateVerifyRequestSchema = z.object({
  txnId: z.string().min(1),
  otp: z.string().regex(OTP_PATTERN, 'OTP must be 6 digits.'),
});
export type AbhaCreateVerifyRequest = z.infer<typeof AbhaCreateVerifyRequestSchema>;

export const AbhaCreateVerifyResponseSchema = z.object({
  // The 14-digit ABHA number — what every downstream gateway wants
  // (PMJAY policies lookup, NHCX coverage check).
  abhaNumber: z.string().min(14).max(14),
  // The human-readable health ID (e.g. "priya.sharma@abdm"). Not
  // used by gateways but shown to the patient on completion.
  healthIdNumber: z.string().optional(),
  // ABDM-returned demographic fields. The hospital can pre-populate
  // patient details from these (operator confirms then saves).
  fullName: z.string().optional(),
  gender: z.enum(['M', 'F', 'O']).optional(),
  dateOfBirth: z.string().optional(), // YYYY-MM-DD if present
});
export type AbhaCreateVerifyResponse = z.infer<typeof AbhaCreateVerifyResponseSchema>;
