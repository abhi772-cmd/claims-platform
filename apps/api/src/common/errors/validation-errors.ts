import { ErrorCodes } from '@claims/error-codes';

import { DomainError } from './domain-error';

// Domain-level validation failure with a per-field errors map. Distinct
// from the global ZodValidationPipe filter — used when validation needs
// to consult the database (e.g. CIDR list update) before deciding the
// request is bad.
export class ValidationFailedError extends DomainError {
  constructor(errors: Record<string, string[]>, detail?: string) {
    super(
      ErrorCodes.VALIDATION_FAILED,
      detail !== undefined ? { detail, errors } : { errors },
    );
  }
}
