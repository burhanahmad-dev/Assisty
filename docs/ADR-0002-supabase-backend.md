# Assisty — ADR-0002: Supabase as the Backend Platform

> **Status:** ACCEPTED (2026-06-01). Supersedes the GCP-specific infrastructure choices in ADR-0001 and the doc set. The *shape* of the winning architecture (stateless edge → durable queue → stateless AI worker → single Postgres+pgvector under RLS → LiteLLM model gateway) is **unchanged**; only the *managed primitives* change from raw GCP to Supabase.

## Context

ADR-0001 chose a "Custom Cloud-Native" architecture on raw GCP primitives (Cloud SQL, Cloud KMS, Memorystore, Firebase Auth). The founder has chosen **Supabase** as the backend platform. This is a strong fit because the whole isolation model already depends on **Postgres + pgvector + Row-Level Security** — which *is* Supabase's core. Supabase collapses several separate GCP services into one managed product, which is ideal for a solo/small team.

## Decision

**Use Supabase as the primary backend platform: Postgres (system of record) + pgvector (vectors) + RLS (tenant isolation) + Auth + Storage + Realtime + Queues (pgmq) + Vault (secret/token encryption).** Keep a thin custom compute layer (NestJS) for the synchronous webhook edge and the AI worker, because the live turn needs a long-lived Node process, not a 150s-capped Edge Function.

## The authoritative mapping (old → new)

| Concern | ADR-0001 (GCP) | **ADR-0002 (Supabase)** | Notes |
|---|---|---|---|
| System of record | Cloud SQL Postgres 16 | **Supabase Postgres** | Same engine. Firestore stays **rejected** (no true RLS; per-op pricing). |
| Vector store | pgvector on Cloud SQL | **pgvector on Supabase** | Built-in extension. One store for relational + vectors, one RLS model. Qdrant remains the documented swap-in behind the `Retriever` interface. |
| Tenant isolation | RLS + FORCE RLS, `SET LOCAL app.tenant_id` | **RLS + FORCE RLS — unchanged**, and *more native*: client (Flutter) reads are auto-scoped by RLS policies reading the JWT claim (`auth.jwt() ->> 'tenant_id'`). | See the `service_role` warning below — it is load-bearing. |
| Auth | Firebase Auth (identity only) | **Supabase Auth** (JWT) | RLS policies read the tenant from the JWT. A custom `tenant_id` claim is set on the user's JWT at login. |
| Token/secret encryption | Cloud KMS envelope (per-tenant DEK/KEK) | **Supabase Vault** (pgsodium AEAD, per-DB root key) for channel access tokens; **plus** an app-level per-tenant AES-256-GCM layer for defense-in-depth + crypto-shred. | Vault encrypts at rest and in dumps. Per-tenant app-key deletion = GDPR crypto-shred. |
| Async queue | Memorystore Redis + BullMQ | **Supabase Queues (`pgmq`) + `pg_cron`** for `ingest`, `reembed`, `re-sync (crawl)`, `outbound-send`, `billing-meter`. | No separate Redis to operate. *Alternative kept on file:* Upstash Redis + BullMQ if richer queue semantics are needed later. |
| Scheduled jobs (re-sync, etc.) | (implicit Cloud Scheduler) | **`pg_cron`** (1–59s granularity) invoking Edge Functions via `pg_net`. | Powers the Knowledge Base **website re-sync** schedule. |
| File storage (KB uploads) | Cloud Storage | **Supabase Storage** | Holds uploaded PDF/DOCX/TXT before ingestion. |
| Live dashboard realtime | SSE on Cloud Run | **Supabase Realtime** (Postgres CDC over WebSocket) | SSE kept only as a fallback. |
| Synchronous edge + AI worker | NestJS on Cloud Run | **NestJS on Cloud Run / Fly.io / Railway — unchanged** | Long-lived Node process for the live turn. Supabase Edge Functions (Deno, 150s) handle *lightweight* async/ingest tasks off `pgmq`. |
| Model gateway | LiteLLM Proxy (self-hosted) | **LiteLLM Proxy — unchanged** | Per-tenant virtual keys; GPT/Gemini selectable; auto-fallback. |
| Mobile push | FCM | **FCM — unchanged** | Supabase has no mobile push. |
| Rate-limit / idempotency / hot cache | Redis | **Postgres** (`idempotency` table, `wamid` unique constraint) + optional Upstash Redis if hot-path latency demands it. | Dedupe via unique constraint instead of Redis `SETNX`. |
| Observability | Cloud Logging/Trace/Monitoring | Host logs (Cloud Run/Fly) + **Supabase logs** + OpenTelemetry + **Langfuse** (unchanged). | |

## ⚠️ Load-bearing security warning: `service_role` bypasses RLS

Supabase's `service_role` key **bypasses Row-Level Security** — exactly the weakness (Firebase Admin SDK bypassing security rules) that disqualified the Firebase-native design in ADR-0001. Therefore:

- The **AI worker and edge MUST NOT use `service_role` for tenant data.** They use a **dedicated non-superuser Postgres role with RLS enforced**, and set tenant context per transaction (`SET LOCAL app.tenant_id` / scoped JWT). `service_role` is reserved for narrow, audited admin/migration tasks only.
- The **async-writer re-stamp rule still holds**: any write from a less-trusted plane (ingest jobs, re-sync crawlers, Edge Functions, future n8n) is re-validated and re-stamped with `tenant_id`.
- The **"zero rows without tenant context"** automated invariant test still applies.

## What does NOT change

- The architecture's *shape* and priorities (isolation #1, predictable scale, pre-flight spend caps).
- The **n8n verdict** — still not the brain.
- LiteLLM model routing (GPT vs Gemini), RAG design, guardrails, the usage-ledger spend caps, Stripe billing, the Meta Tech Provider / Google Play strategy, and the Flutter + Riverpod app.

## Consequences / open sub-decisions

- **Region / data residency:** Supabase projects pick a region (AWS). The critic's GDPR-residency open decision (ADR-0001 / docs/07) still stands — choose the region for the target market before launch.
- **Edge Functions timeout (150s):** fine for chunk/embed/crawl tasks; long crawls must be **chunked into queued sub-jobs**, not one long function.
- **Vault granularity:** Vault uses a per-database root key, not per-tenant KMS keys; the app-level per-tenant AES layer restores per-tenant crypto-shred. Confirm this is acceptable for the compliance target.
- **Connection pooling:** use Supabase's pooler (Supavisor) in **transaction mode** — and remember `SET LOCAL` (per-transaction) is mandatory so tenant context never leaks across pooled connections.

*Related: [ADR-0001](./ADR-0001-architecture-choice.md) · [Knowledge Base module](./08-knowledge-base.md) · backend details in [04-data-model.md](./04-data-model.md) and [03-security.md](./03-security.md).*
