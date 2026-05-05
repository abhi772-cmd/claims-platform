import {
  type DoctorTokenPreview,
  type IssueDoctorTokenRequest,
  type IssueDoctorTokenResponse,
  type SignWithDoctorTokenRequest,
  type SignWithDoctorTokenResponse,
} from '@claims/contracts';

import { apiRequest } from './client';

export const DoctorApi = {
  issue: (body: IssueDoctorTokenRequest): Promise<IssueDoctorTokenResponse> =>
    apiRequest<IssueDoctorTokenResponse>('/preauth/doctor-tokens', { method: 'POST', body }),

  preview: (rawToken: string): Promise<DoctorTokenPreview> =>
    apiRequest<DoctorTokenPreview>(
      `/preauth/doctor-tokens/${encodeURIComponent(rawToken)}/preview`,
    ),

  sign: (
    rawToken: string,
    body: SignWithDoctorTokenRequest,
  ): Promise<SignWithDoctorTokenResponse> =>
    apiRequest<SignWithDoctorTokenResponse>(
      `/preauth/doctor-tokens/${encodeURIComponent(rawToken)}/sign`,
      { method: 'POST', body },
    ),
};
