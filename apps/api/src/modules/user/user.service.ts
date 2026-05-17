import {
  type RoleName,
  type TenantUserSummary,
  type UserStatus,
} from '@claims/contracts';
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

  // Admin /tenant/users directory listing. Returns the
  // lightweight per-row summary the admin page renders — identity
  // + roles + status + last login. Ordered by status (invited
  // first, so admins see pending invitations at the top of the
  // page) then by createdAt desc so newest hires sit above stale
  // accounts.
  async listForTenant(tenantId: string): Promise<TenantUserSummary[]> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const rows = await tx.user.findMany({
        where: { tenantId },
        include: { userRoles: { include: { role: true } } },
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      });
      return rows.map((u) => ({
        id: u.id,
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        designation: u.designation,
        status: u.status as UserStatus,
        roles: u.userRoles.map((ur) => ur.role.name as RoleName),
        mfaEnabled: u.mfaEnabled,
        lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
        inviteExpiresAt: u.inviteTokenExpiresAt
          ? u.inviteTokenExpiresAt.toISOString()
          : null,
        createdAt: u.createdAt.toISOString(),
      }));
    });
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
