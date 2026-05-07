// Slice BG — domain errors for the PMJAY biometric gate.

import { ErrorCodes } from '@claims/error-codes';

import { DomainError } from './domain-error';

// Thrown by PreauthService.submit + ClaimSubmitService.submit when
// the tenant is in pmjayMode='on' but no recent biometric
// verification exists for the case + process. Maps to HTTP 412 so
// the frontend treats it as a precondition / "do this first" rather
// than a validation error.
export class BiometricVerificationRequiredError extends DomainError {
  constructor(detail?: string) {
    super(
      ErrorCodes.BIOMETRIC_VERIFICATION_REQUIRED,
      detail !== undefined ? { detail } : undefined,
    );
  }
}

// Thrown by the biometric service when the underlying ABDM adapter
// returns a `failed` status on init or verify. Maps to HTTP 422 —
// the operator can retry or switch auth modes.
export class BiometricVerificationFailedError extends DomainError {
  constructor(detail?: string) {
    super(
      ErrorCodes.BIOMETRIC_VERIFICATION_FAILED,
      detail !== undefined ? { detail } : undefined,
    );
  }
}
