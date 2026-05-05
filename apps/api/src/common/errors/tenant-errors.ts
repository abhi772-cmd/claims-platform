import { ErrorCodes } from '@claims/error-codes';

import { DomainError } from './domain-error';

export class LifecycleTransitionInvalidError extends DomainError {
  constructor(detail?: string) {
    super(
      ErrorCodes.TENANT_LIFECYCLE_TRANSITION_INVALID,
      detail !== undefined ? { detail } : undefined,
    );
  }
}

export class ReadinessCheckFailedError extends DomainError {
  constructor(detail?: string) {
    super(
      ErrorCodes.TENANT_READINESS_CHECK_FAILED,
      detail !== undefined ? { detail } : undefined,
    );
  }
}

export class TenantNotFoundError extends DomainError {
  constructor() {
    super(ErrorCodes.TENANT_NOT_FOUND);
  }
}
