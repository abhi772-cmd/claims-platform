import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';

export interface UserWithRoles {
  id: string;
  tenantId: string;
  email: string;
  firstName: string;
  lastName: string;
  status: string;
  passwordHash: string;
  mustChangePassword: boolean;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  roles: { name: string; permissions: string[] }[];
}

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  // Used by AuthService.login. Bypasses tenant context (login is pre-tenant).
  // Reads via the migrator-equivalent flow are NOT used here — we use the
  // platform_admin GUC role to scan across tenants. The result is treated
  // strictly as opaque inside auth flow.
  async findByEmailForLogin(email: string): Promise<UserWithRoles | null> {
    return this.prisma.runInTenantContext(
      // dummy tenant id; the platform_admin role bypasses tenant filtering.
      '00000000-0000-0000-0000-000000000000',
      'platform_admin',
      async (tx) => {
        const user = await tx.user.findUnique({
          where: { email },
          include: { userRoles: { include: { role: true } } },
        });
        if (!user) return null;
        return {
          id: user.id,
          tenantId: user.tenantId,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          status: user.status,
          passwordHash: user.passwordHash,
          mustChangePassword: user.mustChangePassword,
          failedLoginAttempts: user.failedLoginAttempts,
          lockedUntil: user.lockedUntil,
          roles: user.userRoles.map((ur) => ({
            name: ur.role.name,
            permissions: ur.role.permissions as string[],
          })),
        };
      },
    );
  }

  async getMe(
    tenantId: string,
    userId: string,
  ): Promise<{
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    tenantId: string;
    tenantSlug: string;
    tenantDisplayName: string;
    roles: string[];
    permissions: string[];
    mustChangePassword: boolean;
  } | null> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        include: {
          userRoles: { include: { role: true } },
          tenant: { select: { slug: true, displayName: true } },
        },
      });
      if (!user) return null;
      const roles = user.userRoles.map((ur) => ur.role.name);
      const permissions = Array.from(
        new Set(user.userRoles.flatMap((ur) => ur.role.permissions as string[])),
      );
      return {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        tenantId: user.tenantId,
        tenantSlug: user.tenant.slug,
        tenantDisplayName: user.tenant.displayName,
        roles,
        permissions,
        mustChangePassword: user.mustChangePassword,
      };
    });
  }
}
