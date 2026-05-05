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

export class InviteTokenExpiredError extends DomainError {
  constructor() {
    super(ErrorCodes.AUTH_INVITE_TOKEN_EXPIRED);
  }
}

export class InviteTokenUsedError extends DomainError {
  constructor() {
    super(ErrorCodes.AUTH_INVITE_TOKEN_USED);
  }
}

export class InviteTokenRevokedError extends DomainError {
  constructor() {
    super(ErrorCodes.AUTH_INVITE_TOKEN_REVOKED);
  }
}

export class PasswordTooWeakError extends DomainError {
  constructor(detail?: string) {
    super(ErrorCodes.AUTH_PASSWORD_TOO_WEAK, detail !== undefined ? { detail } : undefined);
  }
}

export class PasswordBreachedError extends DomainError {
  constructor() {
    super(ErrorCodes.AUTH_PASSWORD_BREACHED);
  }
}

export class PasswordReusedError extends DomainError {
  constructor() {
    super(ErrorCodes.AUTH_PASSWORD_REUSED);
  }
}

export class PasswordResetTokenInvalidError extends DomainError {
  constructor() {
    super(ErrorCodes.AUTH_PASSWORD_RESET_TOKEN_INVALID);
  }
}

export class PasswordResetTokenExpiredError extends DomainError {
  constructor() {
    super(ErrorCodes.AUTH_PASSWORD_RESET_TOKEN_EXPIRED);
  }
}

export class PasswordResetTokenUsedError extends DomainError {
  constructor() {
    super(ErrorCodes.AUTH_PASSWORD_RESET_TOKEN_USED);
  }
}

export class PasswordResetRateLimitError extends DomainError {
  constructor(detail?: string) {
    super(
      ErrorCodes.AUTH_PASSWORD_RESET_LIMIT_REACHED,
      detail !== undefined ? { detail } : undefined,
    );
  }
}

export class CurrentPasswordIncorrectError extends DomainError {
  constructor() {
    super(ErrorCodes.AUTH_CURRENT_PASSWORD_INCORRECT);
  }
}

export class MfaInvalidError extends DomainError {
  constructor() {
    super(ErrorCodes.AUTH_MFA_INVALID);
  }
}

export class MfaAlreadyEnrolledError extends DomainError {
  constructor() {
    super(ErrorCodes.AUTH_MFA_ALREADY_ENROLLED);
  }
}

export class MfaNotEnrolledError extends DomainError {
  constructor() {
    super(ErrorCodes.AUTH_MFA_NOT_ENROLLED);
  }
}

export class MfaSetupNotPendingError extends DomainError {
  constructor() {
    super(ErrorCodes.AUTH_MFA_SETUP_NOT_PENDING);
  }
}

export class MfaChallengeInvalidError extends DomainError {
  constructor() {
    super(ErrorCodes.AUTH_MFA_CHALLENGE_INVALID);
  }
}

export class MfaChallengeExpiredError extends DomainError {
  constructor() {
    super(ErrorCodes.AUTH_MFA_CHALLENGE_EXPIRED);
  }
}

export class IpNotAllowedError extends DomainError {
  constructor() {
    super(ErrorCodes.AUTH_IP_NOT_ALLOWED);
  }
}

export class ConcurrentSessionLimitError extends DomainError {
  constructor() {
    super(ErrorCodes.AUTH_CONCURRENT_SESSION_LIMIT);
  }
}

export class DoctorTokenExpiredError extends DomainError {
  constructor() {
    super(ErrorCodes.AUTH_DOCTOR_TOKEN_EXPIRED);
  }
}

export class DoctorTokenInvalidError extends DomainError {
  constructor() {
    super(ErrorCodes.AUTH_DOCTOR_TOKEN_INVALID);
  }
}

export class HprVerificationFailedError extends DomainError {
  constructor() {
    super(ErrorCodes.AUTH_HPR_VERIFICATION_FAILED);
  }
}
