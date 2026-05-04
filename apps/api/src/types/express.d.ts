import type { Prisma, PrismaClient } from '@prisma/client';

// Tenant-scoped Prisma client is an open transaction returned by $transaction.
export type TenantPrisma = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
> &
  Prisma.TransactionClient;

declare global {
  namespace Express {
    interface AuthenticatedUser {
      userId: string;
      tenantId: string;
      role: 'tenant' | 'platform_admin';
      roles: readonly string[];
      // Effective permission set — union of all assigned roles' permissions.
      // Computed at login and embedded in the JWT so the RolesGuard does not
      // re-query the DB per request.
      permissions: readonly string[];
      sessionId: string;
    }

    // Passport assigns the strategy validate() return value to req.user.
    // We extend that so our typed AuthenticatedUser is what controllers see.
    interface User extends AuthenticatedUser {}

    interface Request {
      tenantId?: string;
      tenantPrisma?: TenantPrisma;
      correlationId?: string;
    }
  }
}

export {};
