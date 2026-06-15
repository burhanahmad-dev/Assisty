-- migrate:no-transaction
-- =============================================================================
-- Assisty — Row Level Security (hard multi-tenant isolation).
-- Idempotent. Safe to re-run. Runs in autocommit (role/RLS DDL doesn't wrap
-- cleanly in a single pooled transaction over Supabase's pooler).
--
-- Model: the app connects as `postgres` (pooler-friendly) but every TENANT data
-- transaction does `SET LOCAL ROLE assisty_app; SET LOCAL app.tenant_id = ...`.
-- `assisty_app` is NOLOGIN / NOSUPERUSER / NOBYPASSRLS and is NOT a table owner,
-- so RLS is enforced against it. Tenant RESOLUTION + auth bootstrap run as plain
-- `postgres` (owner) on the identity tables (tenants/users are ENABLE-only, not
-- FORCE), so the guard can resolve a tenant before any tenant context exists.
-- =============================================================================

-- 1) The restricted role the app SET ROLEs into per transaction. -------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'assisty_app') THEN
    CREATE ROLE assisty_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- Let the connecting role switch into assisty_app per transaction. NOTE: the
-- literal `GRANT ... TO CURRENT_USER` form trips Supabase's pooler (closes the
-- connection); the dynamic EXECUTE form is accepted.
DO $$ BEGIN EXECUTE format('GRANT assisty_app TO %I', current_user); END $$;

-- 2) Privileges for the app role (DML only — never DDL). ----------------------
GRANT USAGE ON SCHEMA public TO assisty_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO assisty_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO assisty_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO assisty_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO assisty_app;

-- 3) RLS policies. ------------------------------------------------------------
-- Data tables: ENABLE + FORCE (RLS applies even to a table owner — defense in
-- depth against any accidental owner-context query).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'channel_connections','conversations','messages','kb_documents',
    'kb_chunks','usage_ledger','products','orders','tenant_settings'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      || 'USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
      || 'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;

-- Identity tables: ENABLE only (owner `postgres` bypasses so auth resolution +
-- bootstrap work pre-context; the app role `assisty_app` is still scoped).
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenants;
CREATE POLICY tenant_isolation ON tenants
  USING (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON users;
CREATE POLICY tenant_isolation ON users
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- webhook_events has no tenant_id (idempotency keys, resolved pre-tenant) — no
-- RLS; it is only ever touched on the resolution path.
