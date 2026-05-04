import { Permissions } from '@claims/contracts';
import { Reflector } from '@nestjs/core';

import { RolesGuard } from './roles.guard';
import { REQUIRE_PERMISSION_KEY } from '../decorators/require-permission.decorator';
import { DomainError } from '../errors/domain-error';

function makeContext(user: Express.AuthenticatedUser | undefined): {
  switchToHttp: () => { getRequest: () => { user: typeof user } };
  getHandler: () => unknown;
  getClass: () => unknown;
} {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => 'handler',
    getClass: () => 'class',
  };
}

function makeReflector(required: string[] | undefined): Reflector {
  const reflector = new Reflector();
  jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
    if (key === REQUIRE_PERMISSION_KEY) return required;
    return undefined;
  });
  return reflector;
}

const baseUser: Express.AuthenticatedUser = {
  userId: 'u1',
  tenantId: 't1',
  role: 'tenant',
  roles: ['tenant_admin'],
  permissions: [Permissions.USER_INVITE, Permissions.CASE_VIEW],
  sessionId: 's1',
};

describe('RolesGuard', () => {
  it('allows when no permission requirement is declared', () => {
    const guard = new RolesGuard(makeReflector(undefined));
    expect(guard.canActivate(makeContext(baseUser) as never)).toBe(true);
  });

  it('allows when user has all required permissions', () => {
    const guard = new RolesGuard(makeReflector([Permissions.USER_INVITE]));
    expect(guard.canActivate(makeContext(baseUser) as never)).toBe(true);
  });

  it('throws AUTH_INSUFFICIENT_PERMISSIONS when user is missing one', () => {
    const guard = new RolesGuard(makeReflector([Permissions.USER_INVITE, Permissions.AUDIT_VIEW]));
    expect(() => guard.canActivate(makeContext(baseUser) as never)).toThrow(DomainError);
    try {
      guard.canActivate(makeContext(baseUser) as never);
    } catch (err) {
      expect((err as DomainError).code).toBe('AUTH_INSUFFICIENT_PERMISSIONS');
    }
  });

  it('throws AUTH_SESSION_EXPIRED when no user is on the request', () => {
    const guard = new RolesGuard(makeReflector([Permissions.USER_INVITE]));
    try {
      guard.canActivate(makeContext(undefined) as never);
      fail('expected throw');
    } catch (err) {
      expect((err as DomainError).code).toBe('AUTH_SESSION_EXPIRED');
    }
  });

  it('AND-combines multiple required permissions', () => {
    const guard = new RolesGuard(makeReflector([Permissions.USER_INVITE, Permissions.CASE_VIEW]));
    expect(guard.canActivate(makeContext(baseUser) as never)).toBe(true);
  });
});
