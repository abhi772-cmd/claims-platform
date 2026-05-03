import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { type Request } from 'express';

import { DomainError } from '../errors/domain-error.js';
import { ErrorCodes } from '@claims/error-codes';

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.authUser) {
    throw new DomainError(ErrorCodes.AUTH_SESSION_EXPIRED);
  }
  return req.authUser;
});
