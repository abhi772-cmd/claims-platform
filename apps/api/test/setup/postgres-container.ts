// Spins up an ephemeral Postgres 16 instance via testcontainers.
// Returns connection URLs for both the migrator and app roles, plus a teardown.
//
// We deliberately create the SAME role topology as the dev compose stack:
//   - claims_migrator owns tables; runs migrations.
//   - claims_app is the runtime role (NOSUPERUSER, NOBYPASSRLS).
// Tests that prove RLS isolation MUST connect as claims_app, not the migrator.

import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

export interface PgHandles {
  container: StartedTestContainer;
  migratorUrl: string;
  appUrl: string;
  shutdown: () => Promise<void>;
}

export async function startPostgres(): Promise<PgHandles> {
  const initSql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_migrator') THEN
    CREATE ROLE claims_migrator LOGIN PASSWORD 'm' NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    CREATE ROLE claims_app LOGIN PASSWORD 'a' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
CREATE DATABASE claims_test OWNER claims_migrator;
\\connect claims_test
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO claims_app;
GRANT CREATE, USAGE ON SCHEMA public TO claims_migrator;
ALTER DEFAULT PRIVILEGES FOR ROLE claims_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO claims_app;
ALTER DEFAULT PRIVILEGES FOR ROLE claims_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO claims_app;
`;
  const dir = mkdtempSync(join(tmpdir(), 'claims-pg-init-'));
  const initFile = join(dir, 'init.sql');
  writeFileSync(initFile, initSql, 'utf8');

  const container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: 'postgres',
      POSTGRES_PASSWORD: 'postgres',
      POSTGRES_DB: 'postgres',
    })
    .withBindMounts([{ source: initFile, target: '/docker-entrypoint-initdb.d/init.sql', mode: 'ro' }])
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const migratorUrl = `postgresql://claims_migrator:m@${host}:${port}/claims_test?schema=public`;
  const appUrl = `postgresql://claims_app:a@${host}:${port}/claims_test?schema=public`;

  // Apply migrations as the migrator role.
  execSync('npx prisma migrate deploy', {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL_MIGRATOR: migratorUrl, DATABASE_URL: migratorUrl },
  });

  return {
    container,
    migratorUrl,
    appUrl,
    shutdown: async (): Promise<void> => {
      await container.stop();
    },
  };
}

export function makePrisma(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}
