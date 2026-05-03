import { ErrorCodes, ErrorHttpStatus, ErrorPresentations, type ProblemDetails } from '@claims/error-codes';
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { type Request, type Response } from 'express';
import { ZodError } from 'zod';

import { DomainError } from '../errors/domain-error.js';

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) ?? undefined;

    const problem = this.toProblemDetails(exception, req.originalUrl, correlationId);

    if (problem.status >= 500) {
      this.logger.error({ err: redact(exception), correlationId }, 'Unhandled exception');
    } else if (problem.status >= 400) {
      this.logger.warn({ code: problem.code, status: problem.status, correlationId }, problem.title);
    }

    res.status(problem.status).type('application/problem+json').json(problem);
  }

  private toProblemDetails(
    exception: unknown,
    instance: string,
    correlationId: string | undefined,
  ): ProblemDetails {
    if (exception instanceof DomainError) {
      const presentation = ErrorPresentations[exception.code];
      return cleanProblem({
        type: `urn:claims:error:${exception.code}`,
        title: presentation.title,
        status: exception.httpStatus,
        code: exception.code,
        detail: exception.detail,
        errors: exception.errors,
        instance,
        correlationId,
      });
    }

    if (exception instanceof ZodError) {
      const errors: Record<string, string[]> = {};
      for (const issue of exception.issues) {
        const path = issue.path.join('.') || '_root';
        const bucket = errors[path] ?? (errors[path] = []);
        bucket.push(issue.message);
      }
      const presentation = ErrorPresentations[ErrorCodes.VALIDATION_FAILED];
      return cleanProblem({
        type: `urn:claims:error:${ErrorCodes.VALIDATION_FAILED}`,
        title: presentation.title,
        status: ErrorHttpStatus.VALIDATION_FAILED,
        code: ErrorCodes.VALIDATION_FAILED,
        errors,
        instance,
        correlationId,
      });
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code =
        status === 401
          ? ErrorCodes.AUTH_SESSION_EXPIRED
          : status === 403
            ? ErrorCodes.AUTH_INSUFFICIENT_PERMISSIONS
            : status === 404
              ? ErrorCodes.TENANT_NOT_FOUND
              : ErrorCodes.INTERNAL_ERROR;
      const presentation = ErrorPresentations[code];
      return cleanProblem({
        type: `urn:claims:error:${code}`,
        title: presentation.title,
        status,
        code,
        detail: exception.message,
        instance,
        correlationId,
      });
    }

    const presentation = ErrorPresentations[ErrorCodes.INTERNAL_ERROR];
    return cleanProblem({
      type: `urn:claims:error:${ErrorCodes.INTERNAL_ERROR}`,
      title: presentation.title,
      status: 500,
      code: ErrorCodes.INTERNAL_ERROR,
      instance,
      correlationId,
    });
  }
}

function cleanProblem(p: ProblemDetails): ProblemDetails {
  // Strip undefined keys so the response stays terse and avoids leaking shape.
  const out: ProblemDetails = {
    type: p.type,
    title: p.title,
    status: p.status,
    code: p.code,
  };
  if (p.detail !== undefined) out.detail = p.detail;
  if (p.instance !== undefined) out.instance = p.instance;
  if (p.correlationId !== undefined) out.correlationId = p.correlationId;
  if (p.errors !== undefined) out.errors = p.errors;
  return out;
}

function redact(exception: unknown): unknown {
  if (exception instanceof Error) {
    return { name: exception.name, message: exception.message, stack: exception.stack };
  }
  return exception;
}
