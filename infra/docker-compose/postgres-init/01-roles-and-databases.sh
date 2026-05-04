#!/usr/bin/env bash
# Runs once on first container start. Creates the dev/test databases and the
# two non-superuser roles the platform uses:
#
#   claims_migrator — owns tables, runs migrations. NOSUPERUSER, NOBYPASSRLS.
#   claims_app      — runtime role. NOSUPERUSER, NOBYPASSRLS, no DDL.
#
# RLS policies use FORCE ROW LEVEL SECURITY so the migrator-as-owner is also
# subject to them. Both roles must lack BYPASSRLS — confirmed at the canary test.

set -euo pipefail

MIGRATOR_PWD="${CLAIMS_MIGRATOR_PASSWORD:-claims_migrator_dev}"
APP_PWD="${CLAIMS_APP_PASSWORD:-claims_app_dev}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "postgres" <<-EOSQL
  -- Roles
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_migrator') THEN
      CREATE ROLE claims_migrator LOGIN PASSWORD '${MIGRATOR_PWD}'
        NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
      CREATE ROLE claims_app LOGIN PASSWORD '${APP_PWD}'
        NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    END IF;
  END
  \$\$;

  -- Databases
  CREATE DATABASE claims_dev OWNER claims_migrator;
  CREATE DATABASE claims_test OWNER claims_migrator;
EOSQL

# Per-database setup
for DB in claims_dev claims_test; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$DB" <<-EOSQL
    -- Lock down the public schema to the migrator and app role only.
    REVOKE ALL ON SCHEMA public FROM PUBLIC;
    GRANT USAGE ON SCHEMA public TO claims_app;
    GRANT CREATE, USAGE ON SCHEMA public TO claims_migrator;

    -- Default privileges on objects created later by the migrator.
    ALTER DEFAULT PRIVILEGES FOR ROLE claims_migrator IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO claims_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE claims_migrator IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO claims_app;
EOSQL
done
