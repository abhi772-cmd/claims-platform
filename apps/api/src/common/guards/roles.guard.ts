import { type AppPermission } from '@claims/contracts';
import { ErrorCodes } from '@claims/error-codes';
import { CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Request } from 'express';

import { REQUIRE_PERMISSION_KEY } from '../decorators/require-permission.decorator';
import { DomainError } from '../errors/domain-error';

// Reads the permission requirement from route metadata and the user's
// effective permission set from req.user.permissions, set by JwtStrategy.
// Throws AUTH_INSUFFICIENT_PERMISSIONS (403) if any required permission is missing.
//
// Order: place AFTER JwtAuthGuard. JwtAuthGuard populates req.user; this guard
// inspects it. NestJS evaluates @UseGuards in array order.
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AppPermission[] | undefined>(
      REQUIRE_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) {
      return true;
    }
    const req = context.switchToHttp().getRequest<Request>();
    const user = req.user;
    if (!user) {
      throw new DomainError(ErrorCodes.AUTH_SESSION_EXPIRED);
    }
    const granted = new Set(user.permissions ?? []);
    for (const perm of required) {
      if (!granted.has(perm)) {
        throw new DomainError(ErrorCodes.AUTH_INSUFFICIENT_PERMISSIONS, {
          detail: `Missing permission: ${perm}`,
        });
      }
    }
    return true;
  }
}
