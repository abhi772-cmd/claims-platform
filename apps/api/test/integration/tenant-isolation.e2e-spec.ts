// CANARY TEST — proves RLS multi-tenant isolation.
//
// Nothing else ships if this fails. The hard rules from CLAUDE.md depend on
// the assertions here being green. Specifically:
//   1. Reading from tenant A's GUC context returns ONLY tenant A's rows.
//   2. The platform_admin GUC bypasses tenant filtering as designed.
//   3. FORCE ROW LEVEL SECURITY applies to the table-owning role too —
//      even claims_migrator cannot cross tenants when the GUC is set.
//   4. audit_log UPDATE/DELETE are silently denied (append-only).

import { Prisma, PrismaClient } from '@prisma/client';

import { makePrisma, startPostgres, type PgHandles } from '../setup/postgres-container.js';

jest.setTimeout(120_000);

describe('RLS canary — tenant isolation', () => {
  let pg: PgHandles;
  let migrator: PrismaClient;
  let app: PrismaClient;

  let tenantAId = '';
  let tenantBId = '';
  let userAId = '';
  let userBId = '';

  beforeAll(async () => {
    pg = await startPostgres();
    migrator = makePrisma(pg.migratorUrl);
    app = makePrisma(pg.appUrl);

    // Setup runs under the migrator role with the platform_admin GUC, so we
    // can write rows for both tenants in one place.
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );

      const tenantA = await tx.tenant.create({
        data: { slug: 'tenant-a', displayName: 'Tenant A' },
      });
      const tenantB = await tx.tenant.create({
        data: { slug: 'tenant-b', displayName: 'Tenant B' },
      });
      tenantAId = tenantA.id;
      tenantBId = tenantB.id;

      const userA = await tx.user.create({
        data: {
          tenantId: tenantA.id,
          email: 'alice@tenant-a.test',
          passwordHash: 'irrelevant-hash',
          firstName: 'Alice',
          lastName: 'A',
        },
      });
      const userB = await tx.user.create({
        data: {
          tenantId: tenantB.id,
          email: 'bob@tenant-b.test',
          passwordHash: 'irrelevant-hash',
          firstName: 'Bob',
          lastName: 'B',
        },
      });
      userAId = userA.id;
      userBId = userB.id;

      await tx.auditLog.create({
        data: {
          tenantId: tenantA.id,
          actorType: 'system',
          action: 'created',
          resourceType: 'user',
          resourceId: userA.id,
        },
      });
    });
  });

  afterAll(async () => {
    await app.$disconnect().catch(() => undefined);
    await migrator.$disconnect().catch(() => undefined);
    await pg.shutdown();
  });

  it('returns ONLY tenant A rows when GUC is tenant A (claims_app)', async () => {
    await app.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.tenant_id', ${tenantAId}, true), set_config('app.role', ${'tenant'}, true)`,
      );
      const rows = await tx.user.findMany();
      expect(rows.map((r) => r.id)).toEqual([userAId]);
    });
  });

  it('returns ONLY tenant B rows when GUC is tenant B (claims_app)', async () => {
    await app.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.tenant_id', ${tenantBId}, true), set_config('app.role', ${'tenant'}, true)`,
      );
      const rows = await tx.user.findMany();
      expect(rows.map((r) => r.id)).toEqual([userBId]);
    });
  });

  it('returns ZERO rows when GUC is unset (claims_app)', async () => {
    await app.$transaction(async (tx) => {
      // No set_config — both GUCs are empty/NULL by default.
      const rows = await tx.user.findMany();
      expect(rows).toHaveLength(0);
    });
  });

  it('platform_admin GUC bypasses tenant filtering (claims_app)', async () => {
    await app.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const rows = await tx.user.findMany();
      expect(rows.map((r) => r.id).sort()).toEqual([userAId, userBId].sort());
    });
  });

  it('FORCE RLS applies to the table-owning migrator role too', async () => {
    // Even as the table owner (claims_migrator), if the GUC says tenant A
    // and role 'tenant', tenant B rows are invisible. This is what FORCE
    // ROW LEVEL SECURITY guarantees.
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.tenant_id', ${tenantAId}, true), set_config('app.role', ${'tenant'}, true)`,
      );
      const rows = await tx.user.findMany();
      expect(rows.map((r) => r.id)).toEqual([userAId]);
    });
  });

  it('audit_log UPDATE is silently denied as claims_app', async () => {
    await app.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.tenant_id', ${tenantAId}, true), set_config('app.role', ${'tenant'}, true)`,
      );
      const updated = await tx.auditLog.updateMany({
        where: { tenantId: tenantAId },
        data: { action: 'tampered' },
      });
      expect(updated.count).toBe(0);

      // Confirm nothing actually changed.
      const rows = await tx.auditLog.findMany();
      expect(rows.every((r) => r.action !== 'tampered')).toBe(true);
    });
  });

  it('audit_log DELETE is silently denied as claims_app', async () => {
    await app.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.tenant_id', ${tenantAId}, true), set_config('app.role', ${'tenant'}, true)`,
      );
      const deleted = await tx.auditLog.deleteMany({ where: { tenantId: tenantAId } });
      expect(deleted.count).toBe(0);
    });
  });

  it('claims_app role is NOSUPERUSER NOBYPASSRLS', async () => {
    const rows = await app.$queryRaw<{ rolbypassrls: boolean; rolsuper: boolean }[]>`
      SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rolbypassrls).toBe(false);
    expect(rows[0]?.rolsuper).toBe(false);
  });
});
