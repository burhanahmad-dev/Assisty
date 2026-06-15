# Assisty — Security Review Report (Phase: Security & Production Readiness)

> **Date:** 2026-06-15 · **Scope:** the Security & Production Readiness phase (P1–P5) from [`12-security-production-readiness.md`](./12-security-production-readiness.md).
> **Verdict:** the multi-tenant security foundation is in place and verified. Safe to onboard real businesses once the residual items below are addressed.

---

## 1. What was implemented & tested

| Area | Implementation | Verification | Result |
|---|---|---|---|
| **Authentication** | Global `AuthGuard` verifying Supabase JWTs via JWKS; `@Public()` opt-out; `@CurrentTenant()`; first-login tenant bootstrap | All admin routes hit without a token; invalid/garbage tokens | **401 enforced** (incl. malformed) ✅ |
| **Tenant isolation (RLS)** | `assisty_app` role (NOLOGIN, **NOBYPASSRLS**) + `FORCE RLS` policies on all 9 data tables; `DatabaseService.scoped()` (`SET LOCAL ROLE` + `app.tenant_id`) wired through every repository/service | `npm run test:rls` — positive, **negative cross-tenant** (read/list/update/delete/insert), and no-context invariant | **10/10 pass** ✅ |
| **API protection** | `helmet` headers; `@nestjs/throttler` (120/min global, **20/min on `/web/chat`**); global `ValidationPipe` + validated DTO | Header check; bad/oversized body; 25-request burst | headers set, `400` on junk, **`429` after limit** ✅ |
| **Secret encryption** | `CryptoService` — AES-256-GCM with **per-tenant HKDF keys**; channel tokens encrypted at rest, decrypted on read | `npm run test:crypto` — round-trip, cross-tenant key isolation, random IV, tamper detection, legacy passthrough | **7/7 pass** ✅ |
| **Endpoint audit** | — | 11 protected routes (no token) + 8 public routes | protected **all 401**, public all reachable ✅ |
| **Secret hygiene** | `.env` gitignored; no literal secrets in code | grep tracked files for all key fragments; `git check-ignore` | **no secrets tracked** ✅ |

**Repeatable security tests:** `npm run test:rls` (tenant isolation) and `npm run test:crypto` (token encryption) are committed and should run in CI.

---

## 2. Security posture now

- **No unauthenticated access** to any admin/tenant API. Public surface is limited to: health, the operator-console HTML shell, the customer web-chat + widget, the HMAC-verified WhatsApp webhook, and `/auth/config` (publishable values only).
- **Hard tenant isolation** at the database layer (RLS) — enforced even against a forgotten `WHERE`, because the app runs tenant queries as a non-bypass role with `app.tenant_id` set per transaction.
- **Secrets at rest** (channel tokens) are encrypted per-tenant; a DB dump exposes only ciphertext.
- **Abuse/cost protection** on the public chat endpoint; security headers on all responses; request bodies validated.
- **SQL injection**: not possible — all queries are parameterized (postgres.js tagged templates).

---

## 3. Residual risks / not yet done (tracked, not blockers for the phase)

1. **Pre-flight spend caps not enforced.** `usage_ledger` is written but not checked before a model call — a tenant could exceed budget. (Product promise; implement next.)
2. **HTTP-level two-operator test pending.** Isolation is proven at the DB layer and the app verified to use it; a full A-JWT-vs-B-JWT HTTP test needs two confirmed Supabase logins (blocked only by the email-confirmation setting, not code).
3. **Rotate the secrets shared during development** — Gemini key, OpenRouter key, Supabase DB password. (The encryption master key was generated locally and is fine.)
4. **WhatsApp onboarding write path not built**, so the token-encryption *write* path is unit-tested but not yet exercised live (no real connection exists yet).
5. **CORS is open** (`origin:true`) by design for the embeddable widget; admin safety comes from the JWT guard, not CORS.
6. **Public web-chat uses the single "playground" tenant** (per-tenant widget site-key is deferred); fine for the demo, must land before multi-tenant widget use.
7. **Rate-limit storage is in-memory** (per instance) — move to a shared store (e.g. Redis) before horizontal scaling.
8. **Tamper-evident audit log** (hash-chained) from the original architecture is not yet built.

---

## 4. Recommendation

The phase goal is met: **Assisty now has a production-grade multi-tenant security foundation** (auth + RLS + API protection + encrypted secrets), all verified. Before public launch with real tenants: address residual #1 (spend caps), #2 (confirm the two-operator HTTP test once login is enabled), and #3 (rotate dev secrets). Items #4–#8 are follow-ups that don't block onboarding a controlled set of businesses.

*Related: [`12-security-production-readiness.md`](./12-security-production-readiness.md) (the plan), [`03-security.md`](./03-security.md) (threat model), `ARCHITECTURE.md` §6.*
