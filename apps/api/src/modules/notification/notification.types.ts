// Templates produce a rendered subject + body + sms text. Each template
// is versioned by its file location so updates are reviewable in PR diffs.
// Keep templates pure (no DB calls); they receive the data they need.

export type NotificationChannel = 'email' | 'sms' | 'in_app';

export interface RenderedEmail {
  subject: string;
  text: string;
  html?: string;
}

export interface RenderedSms {
  text: string;
}

export interface RenderedNotification {
  email?: RenderedEmail;
  sms?: RenderedSms;
}

// Keys in this map MUST match the enum below. Each value is the data shape
// the renderer requires. Adding a new template = add to TemplateData and
// register a renderer.
export interface TemplateData {
  user_invitation: {
    inviteUrl: string;
    inviterName: string;
    tenantDisplayName: string;
    expiresInHours: number;
    recipientFirstName?: string;
  };
  password_reset: {
    resetUrl: string;
    expiresInMinutes: number;
    recipientFirstName?: string;
  };
  account_locked: {
    recipientFirstName?: string;
    minutesRemaining: number;
  };
  mfa_otp: {
    code: string;
    expiresInMinutes: number;
  };
  doctor_signature_request: {
    signUrl: string;
    expiresInMinutes: number;
    patientName: string;
    requesterName: string;
  };
  consent_otp: {
    code: string;
    expiresInMinutes: number;
    patientName: string;
  };
}

export type TemplateKey = keyof TemplateData;
