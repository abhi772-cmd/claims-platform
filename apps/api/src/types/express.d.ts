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
      sessionId: string;
    }

    interface Request {
      authUser?: AuthenticatedUser;
      tenantId?: string;
      tenantPrisma?: TenantPrisma;
      correlationId?: string;
    }
  }
}

export {};
