import { ErrorCodes } from '@claims/error-codes';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { type Request } from 'express';

import { DomainError } from '../errors/domain-error';

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<Request>();
  // Passport assigns JwtStrategy.validate() result to req.user.
  if (!req.user) {
    throw new DomainError(ErrorCodes.AUTH_SESSION_EXPIRED);
  }
  return req.user;
});
