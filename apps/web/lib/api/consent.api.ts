import {
  type ConsentListFilter,
  type ConsentListResponse,
  type ConsentOtpInitiateRequest,
  type ConsentOtpInitiateResponse,
  type ConsentOtpVerifyRequest,
  type ConsentOtpVerifyResponse,
  type ConsentRecordRow,
  type GrantConsent,
  type WithdrawConsent,
} from '@claims/contracts';

import { apiRequest } from './client';

const qs = (params: Record<string, string | number | boolean | undefined>): string => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
};

export const ConsentApi = {
  list: (params: ConsentListFilter = {}): Promise<ConsentListResponse> =>
    apiRequest<ConsentListResponse>(`/consents${qs(params)}`),

  findById: (id: string): Promise<ConsentRecordRow> =>
    apiRequest<ConsentRecordRow>(`/consents/${id}`),

  grant: (body: GrantConsent): Promise<ConsentRecordRow> =>
    apiRequest<ConsentRecordRow>('/consents', { method: 'POST', body }),

  withdraw: (id: string, body: WithdrawConsent): Promise<ConsentRecordRow> =>
    apiRequest<ConsentRecordRow>(`/consents/${id}/withdraw`, { method: 'POST', body }),

  // Slice CM — DPDP OTP consent capture. Two-step: initiate mints +
  // dispatches the 6-digit code; verify matches it. The returned otpId
  // is threaded into IntakeConsent.acknowledgementRef when the case
  // form submits.
  otpInitiate: (body: ConsentOtpInitiateRequest): Promise<ConsentOtpInitiateResponse> =>
    apiRequest<ConsentOtpInitiateResponse>('/consents/otp/initiate', {
      method: 'POST',
      body,
    }),

  otpVerify: (body: ConsentOtpVerifyRequest): Promise<ConsentOtpVerifyResponse> =>
    apiRequest<ConsentOtpVerifyResponse>('/consents/otp/verify', {
      method: 'POST',
      body,
    }),
};
