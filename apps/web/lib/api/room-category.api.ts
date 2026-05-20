import {
  type CreateRoomCategoryRequest,
  type RoomCategory,
  type RoomCategoryListResponse,
  type RoomCategoryPayerRate,
  type RoomCategoryPayerRateListResponse,
  type UpdateRoomCategoryRequest,
  type UpsertRoomCategoryPayerRateRequest,
} from '@claims/contracts';

import { apiRequest } from './client';

const qs = (params: Record<string, string | number | boolean | undefined>): string => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
};

export const RoomCategoryApi = {
  // Intake-facing — resolves payer override per row when payerCode set.
  list: (params?: { payerCode?: string }): Promise<RoomCategoryListResponse> =>
    apiRequest<RoomCategoryListResponse>(`/room-categories${qs(params ?? {})}`),

  // Admin: every row including deactivated.
  listAdmin: (): Promise<{ categories: RoomCategory[] }> =>
    apiRequest<{ categories: RoomCategory[] }>('/admin/room-categories'),

  create: (body: CreateRoomCategoryRequest): Promise<RoomCategory> =>
    apiRequest<RoomCategory>('/admin/room-categories', { method: 'POST', body }),

  update: (id: string, body: UpdateRoomCategoryRequest): Promise<RoomCategory> =>
    apiRequest<RoomCategory>(`/admin/room-categories/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body,
    }),

  deactivate: (id: string): Promise<void> =>
    apiRequest<void>(`/admin/room-categories/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  // Per-payer rate overrides.
  listPayerRates: (categoryId: string): Promise<RoomCategoryPayerRateListResponse> =>
    apiRequest<RoomCategoryPayerRateListResponse>(
      `/admin/room-categories/${encodeURIComponent(categoryId)}/payer-rates`,
    ),

  upsertPayerRate: (
    categoryId: string,
    body: UpsertRoomCategoryPayerRateRequest,
  ): Promise<RoomCategoryPayerRate> =>
    apiRequest<RoomCategoryPayerRate>(
      `/admin/room-categories/${encodeURIComponent(categoryId)}/payer-rates`,
      { method: 'PUT', body },
    ),

  deletePayerRate: (categoryId: string, payerCode: string): Promise<void> =>
    apiRequest<void>(
      `/admin/room-categories/${encodeURIComponent(categoryId)}/payer-rates/${encodeURIComponent(payerCode)}`,
      { method: 'DELETE' },
    ),
};
