import { ErrorCodes } from '@claims/error-codes';

import { DomainError } from './domain-error';

export class InvalidCredentialsError extends DomainError {
  constructor() {
    super(ErrorCodes.AUTH_INVALID_CREDENTIALS);
  }
}

export class AccountLockedError extends DomainError {
  constructor(detail?: string) {
    super(ErrorCodes.AUTH_ACCOUNT_LOCKED, detail !== undefined ? { detail } : undefined);
  }
}

export class TenantDisabledError extends DomainError {
  constructor() {
    super(ErrorCodes.TENANT_DISABLED);
  }
}

export class RefreshTokenInvalidError extends DomainError {
  constructor() {
    super(ErrorCodes.AUTH_REFRESH_TOKEN_INVALID);
  }
}

export class RefreshTokenReuseDetectedError extends DomainError {
  constructor() {
    super(ErrorCodes.AUTH_REFRESH_TOKEN_REUSE_DETECTED);
  }
}

export class SessionExpiredError extends DomainError {
  constructor() {
    super(ErrorCodes.AUTH_SESSION_EXPIRED);
  }
}
