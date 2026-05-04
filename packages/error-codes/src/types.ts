// RFC 7807 Problem Details shape used by the API for every domain error response.
// `code` is our extension and is required.

import { type ErrorCode } from './codes';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail?: string;
  instance?: string;
  correlationId?: string;
  errors?: Record<string, string[]>;
}
