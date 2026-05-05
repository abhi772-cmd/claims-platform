// Single place to define cookie names so JwtStrategy and AuthController stay in sync.
export const ACCESS_COOKIE_NAME = 'claims_access';
export const REFRESH_COOKIE_NAME = 'claims_refresh';
// Long-lived "remember this device" cookie. Set when the user opts in
// during /auth/mfa/verify; presence + validity skips the MFA challenge
// on subsequent logins from the same device.
export const TRUSTED_DEVICE_COOKIE_NAME = 'claims_trust';
