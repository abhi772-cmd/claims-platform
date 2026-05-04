import { type RenderedNotification, type TemplateData, type TemplateKey } from './notification.types';

// Pure template renderers. Each takes typed data and returns the rendered
// channels. v1 keeps templates inline; if we grow past ~20 templates,
// move each into its own file under templates/<key>.template.ts.

type Renderer<K extends TemplateKey> = (data: TemplateData[K]) => RenderedNotification;

const userInvitation: Renderer<'user_invitation'> = (data) => {
  const greeting = data.recipientFirstName ? `Hi ${data.recipientFirstName},` : 'Hi,';
  return {
    email: {
      subject: `You're invited to ${data.tenantDisplayName} on DigiSparsh Claims`,
      text:
        `${greeting}\n\n` +
        `${data.inviterName} has invited you to join ${data.tenantDisplayName} ` +
        `on the DigiSparsh Claims Platform.\n\n` +
        `Click this link to accept and set up your account:\n` +
        `${data.inviteUrl}\n\n` +
        `This invitation expires in ${data.expiresInHours} hours.\n\n` +
        `If you weren't expecting this, ignore this email.`,
    },
    sms: {
      text:
        `DigiSparsh Claims: ${data.inviterName} invited you to ${data.tenantDisplayName}. ` +
        `Accept here (expires in ${data.expiresInHours}h): ${data.inviteUrl}`,
    },
  };
};

const passwordReset: Renderer<'password_reset'> = (data) => {
  const greeting = data.recipientFirstName ? `Hi ${data.recipientFirstName},` : 'Hi,';
  return {
    email: {
      subject: 'Reset your DigiSparsh Claims password',
      text:
        `${greeting}\n\n` +
        `We received a request to reset your password. Click this link ` +
        `(valid for ${data.expiresInMinutes} minutes):\n` +
        `${data.resetUrl}\n\n` +
        `If you didn't request this, ignore this email.`,
    },
  };
};

const accountLocked: Renderer<'account_locked'> = (data) => {
  const greeting = data.recipientFirstName ? `Hi ${data.recipientFirstName},` : 'Hi,';
  return {
    email: {
      subject: 'Your DigiSparsh Claims account is temporarily locked',
      text:
        `${greeting}\n\n` +
        `Too many failed sign-in attempts. Your account is locked for ` +
        `${data.minutesRemaining} more minutes. ` +
        `If this wasn't you, contact your admin.`,
    },
  };
};

const mfaOtp: Renderer<'mfa_otp'> = (data) => ({
  email: {
    subject: 'Your DigiSparsh Claims verification code',
    text: `Your verification code is ${data.code}. It expires in ${data.expiresInMinutes} minutes.`,
  },
  sms: {
    text: `DigiSparsh Claims code: ${data.code} (expires in ${data.expiresInMinutes}m)`,
  },
});

const doctorSignatureRequest: Renderer<'doctor_signature_request'> = (data) => ({
  email: {
    subject: `Signature requested: pre-auth for ${data.patientName}`,
    text:
      `${data.requesterName} has asked you to sign the clinical justification ` +
      `for the pre-auth of patient ${data.patientName}.\n\n` +
      `Open the secure link (valid for ${data.expiresInMinutes} minutes):\n` +
      `${data.signUrl}`,
  },
  sms: {
    text:
      `DigiSparsh: ${data.requesterName} requests your signature for ${data.patientName}'s ` +
      `pre-auth. Sign (${data.expiresInMinutes}m): ${data.signUrl}`,
  },
});

const consentOtp: Renderer<'consent_otp'> = (data) => ({
  sms: {
    text:
      `DigiSparsh: Your consent code for ${data.patientName} is ${data.code}. ` +
      `Valid for ${data.expiresInMinutes} minutes.`,
  },
});

const renderers: { [K in TemplateKey]: Renderer<K> } = {
  user_invitation: userInvitation,
  password_reset: passwordReset,
  account_locked: accountLocked,
  mfa_otp: mfaOtp,
  doctor_signature_request: doctorSignatureRequest,
  consent_otp: consentOtp,
};

export function renderTemplate<K extends TemplateKey>(
  key: K,
  data: TemplateData[K],
): RenderedNotification {
  const renderer = renderers[key];
  return renderer(data);
}
