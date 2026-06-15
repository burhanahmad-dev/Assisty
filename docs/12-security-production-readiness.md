# Assisty — Phase: Security & Production Readiness

> **Status:** Planned (2026-06-14). **Gate:** this phase must complete before public deployment / onboarding real businesses, and before the next feature wave (Flutter dashboard, CRM, invoices, shipments).
> **Goal:** make Assisty safe for real, multiple businesses on a public URL — authenticated access, hard per-tenant isolation, abuse protection, encrypted secrets, and a verified clean security review.

---

## 0. Why now / current baseline (from the 2026-06-14 audit)

What's already safe: no secrets in git, parameterized SQL (no SQLi), WhatsApp webhook HMAC.

What's NOT safe yet (this phase fixes all of it):
- **No authentication** on any endpoint (`/test`, `/kb/*`, `/catalog/*`, `/orders/*`, `/settings/*`, `/web/chat`).
- **No DB tenant isolation** — one shared DB, app connects as the privileged `postgres` pooler role, **no RLS**.
- **Tenant resolution is fake** — every service calls `resolveTenant()` = "first tenant" (`ORDER BY created_at LIMIT 1`). There is no real per-request tenant.
- **Channel tokens in plaintext** (`channel_connections.access_token`).
- **CORS `origin:true`**, no rate limiting, no `helmet`, no request validation layer.

> The single hardest change is **#2 (RLS)**: it requires the app to stop connecting as a superuser and instead use a dedicated non-superuser role with `SET LOCAL app.tenant_id` per transaction. Everything else builds around that.

---

## 1. Authentication  *(priority 1)*

**Approach:** Supabase Auth issues JWTs; a NestJS guard verifies them and resolves the tenant. The interim admin surface is the **web console** (`/test`) — Flutter reuses the same JWT API later.

**Tasks**
- Add a `SupabaseAuthGuard` that verifies the Supabase JWT (signature + `exp` + `aud`) on every protected route. Verify via the project JWT secret (HS256) or JWKS (`jose`).
- Resolve identity → tenant: read `sub` (supabase uid) → look up `users.supabase_uid` → `tenant_id`. **First login bootstraps** a tenant + `users` row (replaces "first tenant").
- A request-scoped **tenant context** + `@CurrentTenant()` param decorator. **Delete every `resolveTenant()` "first tenant" call** and read the authenticated tenant instead.
- Login/logout UI on the console (Supabase email+password or magic link); store the session, send `Authorization: Bearer <jwt>`.
- Mark `/webhooks/*` (HMAC-verified) and the public widget chat as **non-JWT** routes explicitly.

**Acceptance:** every admin route returns **401 without a valid JWT**; a logged-in operator only ever acts as their own tenant; new signup auto-provisions a tenant.

**Key files:** new `auth/` module (guard, decorator, bootstrap service); `app.module.ts` (global guard); all `*.controller.ts` (drop `resolveTenant`, use `@CurrentTenant()`); `web.controller.ts` (login UI).

---

## 2. Multi-Tenant Isolation (RLS)  *(priority 2)*

**Approach (architecture-aligned):** a dedicated non-superuser DB role + `FORCE ROW LEVEL SECURITY` + `SET LOCAL app.tenant_id` per transaction. This is the only way isolation survives a forgotten `WHERE`.

**Tasks**
- **Migration:** create role `assisty_app` (NOLOGIN base or login role via pooler), `NOSUPERUSER NOBYPASSRLS`; `GRANT` CRUD on tenant tables (no DDL). Switch `DATABASE_URL` to connect as this role.
- **Migration:** `ENABLE` + `FORCE ROW LEVEL SECURITY` on every tenant table; add policy `USING (tenant_id = current_setting('app.tenant_id')::uuid)` for select/insert/update/delete.
- **`DatabaseService` change:** add a `withTenant(tenantId, fn)` helper that opens a transaction, runs `SET LOCAL app.tenant_id = $1`, then the work. **All tenant queries route through it.** (`pg-boss` keeps its own schema/role.)
- Lead every index with `tenant_id` (most already do).
- **Invariant test:** a query with **no** `app.tenant_id` set must return **zero rows** — automated, runs in CI.

**Acceptance:** with two seeded tenants, tenant A's JWT can never read/write tenant B's rows via any endpoint; the zero-rows-without-context test passes.

**Risk/sequencing:** switching the DB role can break access if grants are incomplete — stage it: (a) add role + grants + policies, (b) verify with the app still on the old role, (c) flip `DATABASE_URL`, (d) run the isolation tests.

---

## 3. API Protection  *(priority 3)*

**Tasks**
- **Rate limiting:** `@nestjs/throttler` — global sane default + a **stricter limit on `/web/chat`** (public, cost-bearing). Per-IP and, where known, per-tenant/session buckets.
- **Abuse protection for `/web/chat`:** max message length, per-session throttle, optional simple bot/replay guard; tie into the (future) pre-flight spend cap.
- **Request validation:** add `class-validator`/`class-transformer` DTOs + a global `ValidationPipe({ whitelist, forbidNonWhitelisted })`. Replace ad-hoc body checks.
- **Security headers:** `helmet`. Tighten **CORS** from `origin:true` to an allowlist for admin routes; keep the widget chat origin-open but rate-limited.

**Acceptance:** flooding `/web/chat` gets `429`; malformed bodies get `400` before hitting services; responses carry hardened headers; admin routes reject unknown origins.

---

## 4. Secret Management  *(priority 4)*

**Approach:** application-level **AES-256-GCM** with a **master key** in env; per-tenant subkeys via **HKDF(master, tenant_id)** so a tenant's data can be **crypto-shredded** by dropping its derived key. (Supabase Vault/pgsodium is a later upgrade.)

**Tasks**
- New `crypto/` module: `encrypt(tenantId, plaintext)` / `decrypt(tenantId, payload)` storing `{ciphertext, iv, authTag}`; key = HKDF(`ENCRYPTION_MASTER_KEY`, salt=tenantId).
- **Encrypt channel tokens at rest:** WhatsApp / Messenger / Instagram `access_token` (+ any provider secret) encrypted before insert, decrypted only at send time. Migration to convert existing plaintext rows (or re-onboard).
- Add `ENCRYPTION_MASTER_KEY` to env + validation; document rotation.
- Never log decrypted secrets (pino redaction already covers headers; extend to token fields).

**Acceptance:** `channel_connections.access_token` holds only ciphertext; a raw DB dump exposes no usable tokens; sending still works (decrypt at use).

---

## 5. Security Review  *(priority 5)*

**Tasks**
- **Endpoint audit:** enumerate every route; classify public vs authenticated vs webhook; confirm guards.
- **Verify no unauthenticated admin access** remains (automated test hitting each admin route without a token → expect 401).
- **Verify no cross-tenant leakage** (automated A-vs-B tests across all resource endpoints).
- Re-run the secret scan; confirm `.env` rotation done; confirm CORS/headers/rate limits live.
- Produce a short **security review report** (what was tested, results, residual risks).

**Acceptance:** a written report showing all admin routes require auth, isolation tests pass, and no secrets are committed/loggable.

---

## Definition of done (phase gate)
1. No admin endpoint is reachable without a valid Supabase JWT.
2. Two-tenant isolation tests pass on every endpoint; zero-rows-without-context invariant holds.
3. `/web/chat` is rate-limited and input-validated; helmet + CORS allowlist live.
4. Channel tokens encrypted at rest; master-key strategy documented; the 3 shared keys rotated.
5. Security review report committed.

**Only after this gate:** Flutter dashboard → CRM → Orders expansion → Invoices → Shipment tracking.

---

## Key decisions to confirm before implementation
1. **Login surface now** = the web console (`/test`) gets Supabase Auth login (recommended), since Flutter is post-phase. ✅/✏️
2. **RLS model** = dedicated non-superuser role + `SET LOCAL app.tenant_id` per transaction (recommended; bigger lift but correct). ✅/✏️
3. **Encryption** = app-level AES-256-GCM + HKDF per-tenant subkeys, master key in env (recommended; Vault later). ✅/✏️

*Related: `docs/03-security.md` (threat model), `ARCHITECTURE.md` §6 (isolation layers), `docs/ADR-0002-supabase-backend.md` (the `service_role`/RLS warning).*
