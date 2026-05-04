import { ErrorCodes } from '@claims/error-codes';

import { DomainError } from './domain-error';

export class UserAlreadyExistsError extends DomainError {
  constructor() {
    super(ErrorCodes.USER_ALREADY_EXISTS);
  }
}

export class UserNotFoundError extends DomainError {
  constructor() {
    super(ErrorCodes.USER_NOT_FOUND);
  }
}

export class InviteRateLimitReachedError extends DomainError {
  constructor(detail?: string) {
    super(ErrorCodes.INVITE_RATE_LIMIT_REACHED, detail !== undefined ? { detail } : undefined);
  }
}

export class InviteNotPendingError extends DomainError {
  constructor() {
    super(ErrorCodes.INVITE_NOT_PENDING);
  }
}
