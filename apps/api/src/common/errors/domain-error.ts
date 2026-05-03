import { ErrorHttpStatus, type ErrorCode } from '@claims/error-codes';

// Base class for any error a service throws. The DomainExceptionFilter maps
// these to RFC 7807 ProblemDetails responses. Services MUST NOT throw raw
// `Error` objects to controllers — the filter has nothing to map them to.
export class DomainError extends Error {
  public readonly code: ErrorCode;
  public readonly httpStatus: number;
  public readonly detail?: string;
  public readonly errors?: Record<string, string[]>;

  constructor(
    code: ErrorCode,
    options?: { detail?: string; errors?: Record<string, string[]>; cause?: unknown },
  ) {
    super(options?.detail ?? code, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'DomainError';
    this.code = code;
    this.httpStatus = ErrorHttpStatus[code];
    if (options?.detail !== undefined) this.detail = options.detail;
    if (options?.errors !== undefined) this.errors = options.errors;
  }
}
