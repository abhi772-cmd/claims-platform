import { type ErrorCode } from './codes';

export type ErrorSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface ErrorPresentation {
  title: string;
  body: string;
  severity: ErrorSeverity;
  primaryAction?: string;
  secondaryAction?: string;
}

export const ErrorPresentations: Record<ErrorCode, ErrorPresentation> = {
  AUTH_INVALID_CREDENTIALS: {
    title: 'Sign in failed',
    body: "The email or password you entered doesn't match our records.",
    severity: 'error',
    primaryAction: 'Try again',
    secondaryAction: 'Reset password',
  },
  AUTH_ACCOUNT_LOCKED: {
    title: 'Account temporarily locked',
    body: 'Too many failed attempts. Try again in 15 minutes or contact your admin.',
    severity: 'error',
    primaryAction: 'OK',
    secondaryAction: 'Contact admin',
  },
  AUTH_MFA_REQUIRED: {
    title: 'Multi-factor authentication required',
    body: 'Enter the 6-digit code from your authenticator app.',
    severity: 'info',
    primaryAction: 'Continue',
    secondaryAction: 'Cancel',
  },
  AUTH_MFA_INVALID: {
    title: 'MFA code incorrect',
    body: "The code you entered didn't match. Codes change every 30 seconds — try the latest one.",
    severity: 'error',
    primaryAction: 'Retry',
    secondaryAction: 'Cancel',
  },
  AUTH_SESSION_EXPIRED: {
    title: 'Your session has expired',
    body: 'For your security, we logged you out after 15 minutes of inactivity. Please sign in again.',
    severity: 'warning',
    primaryAction: 'Sign in',
  },
  AUTH_TENANT_MISMATCH: {
    title: 'Wrong tenant',
    body: "Your account doesn't have access to this organisation. Contact your platform admin if this is unexpected.",
    severity: 'critical',
    primaryAction: 'Sign out',
    secondaryAction: 'Contact admin',
  },
  AUTH_INSUFFICIENT_PERMISSIONS: {
    title: "You don't have permission for this",
    body: "Your role doesn't allow this action. Contact your billing manager or admin if you need access.",
    severity: 'error',
    primaryAction: 'OK',
    secondaryAction: 'Contact admin',
  },
  AUTH_DOCTOR_TOKEN_EXPIRED: {
    title: 'This signature link has expired',
    body: "The link expires 10 minutes after it's sent. Ask your insurance desk to send a new one.",
    severity: 'warning',
    primaryAction: 'OK',
  },
  AUTH_DOCTOR_TOKEN_INVALID: {
    title: 'Invalid signature link',
    body: "This link doesn't look right. Ask your insurance desk for a fresh one.",
    severity: 'error',
    primaryAction: 'OK',
  },
  AUTH_INVITE_TOKEN_EXPIRED: {
    title: 'Invite link expired',
    body: 'Your invite has expired. Ask your admin to send a new one.',
    severity: 'warning',
    primaryAction: 'OK',
  },
  AUTH_INVITE_TOKEN_USED: {
    title: 'Invite already accepted',
    body: 'This invite has already been used. Try signing in instead.',
    severity: 'info',
    primaryAction: 'Sign in',
  },
  AUTH_INVITE_TOKEN_REVOKED: {
    title: 'Invite cancelled',
    body: 'This invite was cancelled. Contact your admin if you need a new one.',
    severity: 'error',
    primaryAction: 'OK',
  },
  AUTH_PASSWORD_TOO_WEAK: {
    title: 'Password is too weak',
    body: 'Use at least 12 characters with a mix of letters, numbers, and symbols.',
    severity: 'warning',
    primaryAction: 'Try again',
  },
  AUTH_PASSWORD_REUSED: {
    title: "You've used this password recently",
    body: "For your security, you can't reuse any of your last 5 passwords.",
    severity: 'warning',
    primaryAction: 'Choose another',
  },
  AUTH_PASSWORD_RESET_LIMIT_REACHED: {
    title: 'Too many reset attempts',
    body: 'Try again in 24 hours or contact your admin.',
    severity: 'warning',
    primaryAction: 'OK',
  },
  AUTH_IP_NOT_ALLOWED: {
    title: 'Sign-in not allowed from this network',
    body: "Your hospital restricts access to specific networks. You're not on one of them right now.",
    severity: 'error',
    primaryAction: 'OK',
    secondaryAction: 'Contact admin',
  },
  AUTH_DEVICE_NOT_TRUSTED: {
    title: 'Confirm this is you',
    body: "We don't recognise this device. Confirm with the code we just sent.",
    severity: 'info',
    primaryAction: 'Continue',
  },
  AUTH_CONCURRENT_SESSION_LIMIT: {
    title: 'Too many active sessions',
    body: 'You signed in elsewhere — your oldest session was logged out.',
    severity: 'info',
    primaryAction: 'OK',
  },
  AUTH_SUSPICIOUS_LOGIN: {
    title: 'Confirm this sign-in',
    body: "Something looks unusual about this sign-in. Confirm it's you with the code we sent.",
    severity: 'warning',
    primaryAction: 'Continue',
  },
  AUTH_HPR_VERIFICATION_FAILED: {
    title: 'HPR registration not active',
    body: "We couldn't verify this doctor's HPR registration. Check the number with ABDM.",
    severity: 'error',
    primaryAction: 'OK',
  },
  AUTH_MFA_ALREADY_ENROLLED: {
    title: 'MFA is already set up',
    body: 'Your account already has multi-factor authentication.',
    severity: 'info',
    primaryAction: 'OK',
  },
  AUTH_MFA_NOT_ENROLLED: {
    title: 'MFA enrollment required',
    body: 'Your role requires MFA. Set it up now to continue.',
    severity: 'warning',
    primaryAction: 'Set up MFA',
  },
  AUTH_BACKUP_CODE_INVALID: {
    title: 'Backup code incorrect',
    body: "That backup code didn't work. Each code can only be used once.",
    severity: 'error',
    primaryAction: 'Try another',
  },
  AUTH_REFRESH_TOKEN_INVALID: {
    title: 'Session no longer valid',
    body: 'Please sign in again.',
    severity: 'warning',
    primaryAction: 'Sign in',
  },
  AUTH_REFRESH_TOKEN_REUSE_DETECTED: {
    title: 'Sign-in reset for safety',
    body: "We detected something unusual with your session. We've signed you out everywhere as a precaution.",
    severity: 'critical',
    primaryAction: 'Sign in',
  },
  AUTH_PASSWORD_CHANGE_REQUIRED: {
    title: 'Set a new password',
    body: 'You need to choose a new password before continuing.',
    severity: 'info',
    primaryAction: 'Change password',
  },

  TENANT_NOT_FOUND: {
    title: 'Organisation not found',
    body: "This organisation doesn't exist.",
    severity: 'error',
    primaryAction: 'OK',
  },
  TENANT_DISABLED: {
    title: 'Organisation is disabled',
    body: 'Your organisation has been temporarily disabled. Contact support.',
    severity: 'critical',
    primaryAction: 'Contact support',
  },
  TENANT_NHCX_NOT_CONFIGURED: {
    title: 'NHCX is not set up yet',
    body: "Your hospital hasn't completed NHCX onboarding. Talk to your platform admin to enable cashless processing.",
    severity: 'warning',
    primaryAction: 'View setup guide',
    secondaryAction: 'Cancel',
  },
  TENANT_PMJAY_NOT_CONFIGURED: {
    title: 'PMJAY is not set up yet',
    body: "Your hospital isn't configured for PMJAY claims. Contact your admin.",
    severity: 'warning',
    primaryAction: 'View setup guide',
    secondaryAction: 'Cancel',
  },
  TENANT_LIFECYCLE_TRANSITION_INVALID: {
    title: 'Cannot move organisation to that state',
    body: "This lifecycle transition isn't allowed.",
    severity: 'error',
    primaryAction: 'OK',
  },
  TENANT_NHCX_CERT_INVALID: {
    title: 'NHCX certificate is invalid',
    body: 'The certificate file is unreadable or in the wrong format.',
    severity: 'error',
    primaryAction: 'Upload again',
  },
  TENANT_NHCX_CERT_EXPIRED: {
    title: 'NHCX certificate has expired',
    body: 'Your NHCX signing certificate is past its expiry date. Renew it before sending claims.',
    severity: 'critical',
    primaryAction: 'OK',
  },
  TENANT_NHCX_CERT_NOT_UPLOADED: {
    title: 'NHCX certificate is required',
    body: 'Upload your NHCX signing certificate to enable cashless processing.',
    severity: 'warning',
    primaryAction: 'Upload now',
  },
  TENANT_PMJAY_STATE_NOT_SUPPORTED: {
    title: 'State not supported yet',
    body: "We don't yet support PMJAY for this state.",
    severity: 'warning',
    primaryAction: 'OK',
  },
  TENANT_READINESS_CHECK_FAILED: {
    title: 'Setup is not complete',
    body: 'Some setup items are still pending before this organisation can go live.',
    severity: 'warning',
    primaryAction: 'View checklist',
  },

  ONBOARDING_STEP_INCOMPLETE: {
    title: 'Setup step required',
    body: 'Complete this step to continue setup.',
    severity: 'info',
    primaryAction: 'Continue',
  },
  ONBOARDING_OUT_OF_ORDER: {
    title: 'Earlier steps required',
    body: 'Finish the earlier setup steps before this one.',
    severity: 'info',
    primaryAction: 'Go back',
  },

  USER_ALREADY_EXISTS: {
    title: 'User already exists',
    body: 'A user with this email is already on the platform.',
    severity: 'warning',
    primaryAction: 'OK',
  },
  USER_NOT_FOUND: {
    title: 'User not found',
    body: "We couldn't find that user.",
    severity: 'error',
    primaryAction: 'OK',
  },
  INVITE_RATE_LIMIT_REACHED: {
    title: 'Too many invites',
    body: "You've sent too many invites to this user in the last 24 hours. Try again tomorrow.",
    severity: 'warning',
    primaryAction: 'OK',
  },
  INVITE_NOT_PENDING: {
    title: 'Invite already accepted',
    body: 'This user has already accepted their invite. They can sign in directly.',
    severity: 'info',
    primaryAction: 'OK',
  },

  AUTH_PASSWORD_RESET_TOKEN_INVALID: {
    title: 'Reset link is invalid',
    body: "This password reset link doesn't look right. Request a new one to continue.",
    severity: 'error',
    primaryAction: 'Request new link',
  },
  AUTH_PASSWORD_RESET_TOKEN_EXPIRED: {
    title: 'Reset link expired',
    body: 'Password reset links expire after 30 minutes for security. Request a new one.',
    severity: 'warning',
    primaryAction: 'Request new link',
  },
  AUTH_PASSWORD_RESET_TOKEN_USED: {
    title: 'Reset link already used',
    body: 'This link has already been used. If you need to reset your password again, request a new link.',
    severity: 'info',
    primaryAction: 'Request new link',
  },
  AUTH_PASSWORD_BREACHED: {
    title: 'This password has been seen in a breach',
    body: 'This password appears in known breach lists and is unsafe. Choose something more unique.',
    severity: 'warning',
    primaryAction: 'Choose another',
  },
  AUTH_CURRENT_PASSWORD_INCORRECT: {
    title: 'Current password is incorrect',
    body: "The current password you entered didn't match.",
    severity: 'error',
    primaryAction: 'Try again',
  },

  VALIDATION_FAILED: {
    title: 'Check the details',
    body: 'Some fields need attention before you can continue.',
    severity: 'warning',
    primaryAction: 'Review',
  },
  INTERNAL_ERROR: {
    title: 'Something went wrong',
    body: 'An unexpected error occurred. Try again, and if it keeps happening contact support.',
    severity: 'error',
    primaryAction: 'Try again',
    secondaryAction: 'Contact support',
  },
  RATE_LIMITED: {
    title: 'Slow down',
    body: 'Too many requests. Take a breath and try again in a moment.',
    severity: 'warning',
    primaryAction: 'OK',
  },
};
