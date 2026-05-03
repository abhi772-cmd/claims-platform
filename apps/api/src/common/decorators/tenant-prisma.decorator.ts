import { ErrorCodes } from '@claims/error-codes';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { type Request } from 'express';

import { DomainError } from '../errors/domain-error.js';

// Returns the tenant-scoped Prisma transaction set by TenantInterceptor.
// Throws if used on a route that didn't go through the interceptor.
export const TenantPrismaParam = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.tenantPrisma) {
      throw new DomainError(ErrorCodes.INTERNAL_ERROR, {
        detail: 'Tenant context missing — this route is not wrapped by TenantInterceptor.',
      });
    }
    return req.tenantPrisma;
  },
);
