import { type LoginRequest, type LoginResponse, type MeResponse } from '@claims/contracts';

import { apiRequest } from './client';

export const AuthApi = {
  login: (body: LoginRequest): Promise<LoginResponse> =>
    apiRequest<LoginResponse>('/auth/login', { method: 'POST', body }),

  me: (signal?: AbortSignal): Promise<MeResponse> =>
    apiRequest<MeResponse>('/auth/me', signal ? { signal } : {}),

  logout: (): Promise<void> => apiRequest<void>('/auth/logout', { method: 'POST' }),
};
