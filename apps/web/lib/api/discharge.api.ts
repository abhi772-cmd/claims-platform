import {
  type ClassifyNonMedicalRequest,
  type ClassifyNonMedicalResponse,
} from '@claims/contracts';

import { apiRequest } from './client';

// T2-13 — non-medical auto-strip classifier. Stateless server-side
// utility; the NonMedicalStripCalculator on case-detail re-POSTs
// every time the operator edits the bill, debounced client-side.
export const DischargeApi = {
  classifyNonMedical: (body: ClassifyNonMedicalRequest): Promise<ClassifyNonMedicalResponse> =>
    apiRequest<ClassifyNonMedicalResponse>('/discharge/classify-non-medical', {
      method: 'POST',
      body,
    }),
};
