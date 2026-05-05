import { ErrorCodes } from '@claims/error-codes';

import { DomainError } from './domain-error';

// Case-not-found currently surfaces as VALIDATION_FAILED with detail.
// We'll add a dedicated CASE_NOT_FOUND code in a later slice once the
// error catalogue catches up; the user-facing modal text already exists
// for similar cases (USER_NOT_FOUND).
export class CaseNotFoundError extends DomainError {
  constructor(detail = 'Case not found.') {
    super(ErrorCodes.VALIDATION_FAILED, { detail });
  }
}
