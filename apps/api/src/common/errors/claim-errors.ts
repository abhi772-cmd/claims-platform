import { ErrorCodes } from '@claims/error-codes';

import { DomainError } from './domain-error';

// We don't have dedicated error codes for these yet — they'll surface
// as VALIDATION_FAILED until the contracts catalogue catches up. Worth
// noting in docs/sprint-2-exit.md when we get there. For now this lets
// callers throw a typed error from the claim engine without the global
// filter falling back to INTERNAL_ERROR.
export class ClaimNotFoundError extends DomainError {
  constructor(detail?: string) {
    super(
      ErrorCodes.VALIDATION_FAILED,
      detail !== undefined ? { detail } : { detail: 'Claim not found.' },
    );
  }
}

export class InvalidClaimTransitionError extends DomainError {
  constructor(detail?: string) {
    super(
      ErrorCodes.VALIDATION_FAILED,
      detail !== undefined ? { detail } : undefined,
    );
  }
}
