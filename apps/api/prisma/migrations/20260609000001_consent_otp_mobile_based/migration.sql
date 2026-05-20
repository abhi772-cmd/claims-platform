-- Slice CM follow-up — OTP rekey from patientId to mobile.
--
-- Architectural correction: the case-intake form creates the patient
-- row AT SUBMIT time, not at consent-capture time. The operator clicks
-- "Send OTP" before any patient row exists, so OTP cannot be keyed
-- off patientId. Reshape:
--
--   - patientId → NULLABLE. Filled in later (at consent-grant time)
--     when the patient row finally exists. Lets follow-up
--     access-ledger queries still join "what OTPs touched this
--     patient" even though the issuance preceded the row.
--   - Drop the patient FK (it's optional now; we still validate
--     tenant membership in code).
--
-- No mobileHash column yet — for v1 we rely on operator-verified
-- linkage (the case-submit attaches the verified otpId; the operator
-- saw both the patient and the OTP confirmation in the same browser
-- session). A future slice adds a hash-based hard cross-check.

ALTER TABLE "consent_otp"
  DROP CONSTRAINT IF EXISTS "consent_otp_patientId_fkey";

ALTER TABLE "consent_otp"
  ALTER COLUMN "patientId" DROP NOT NULL;
