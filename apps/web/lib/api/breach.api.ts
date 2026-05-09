import {
  type BreachIncidentRow,
  type DismissBreachIncident,
  type NotifyBreachIncident,
} from '@claims/contracts';

import { apiRequest } from './client';

// Slice BU pulls in the manage actions on the dashboard so an
// operator can notify/dismiss without leaving the screen. The
// endpoints themselves landed in BS.
export const BreachApi = {
  notify: (id: string, body: NotifyBreachIncident): Promise<BreachIncidentRow> =>
    apiRequest<BreachIncidentRow>(`/breach-incidents/${id}/notify`, {
      method: 'POST',
      body,
    }),

  dismiss: (id: string, body: DismissBreachIncident): Promise<BreachIncidentRow> =>
    apiRequest<BreachIncidentRow>(`/breach-incidents/${id}/dismiss`, {
      method: 'POST',
      body,
    }),

  scan: (): Promise<{ incidentsCreated: number; durationMs: number; completedAt: string }> =>
    apiRequest('/breach-incidents/scan', { method: 'POST' }),
};
