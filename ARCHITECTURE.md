# Assisty — System Architecture Overview

> **Status:** Authoritative entry point for the Assisty engineering docs.
> **Audience:** Solo / small-team builders implementing or operating Assisty.
> **Last reviewed:** 2026-05-30
> **Architecture:** *Assisty Custom Cloud-Native* — NestJS + Cloud Run / Fly.io / Railway + Supabase Postgres (Postgres + pgvector) + Supabase Queues (pgmq) + LiteLLM.
> **Backend platform decision:** see [`docs/ADR-0002-supabase-backend.md`](./docs/ADR-0002-supabase-backend.md) — Supabase is the system-of-record, auth, storage, queue, and realtime substrate.

This is the **map of the whole system**. Read it first. Every other document in [`docs/`](#how-the-docs-fit-together) drills into one slice of what is described here and must stay consistent with it. If a downstream doc contradicts this one, this one wins until it is explicitly revised.

---

## 1. Executive Summary

**Assisty is a multi-tenant AI customer-service SaaS.** A business signs up, connects its own messaging channels (WhatsApp, Instagram, Messenger, a web widget, email), uploads its knowledge (FAQs, policies, catalog), and Assisty answers that business's customers automatically — grounded in *that tenant's* data, in *that tenant's* tone, on *that tenant's* model of choice (GPT or Gemini), with hard spend caps so the bill never runs away.

The architecture is **"own the runtime, rent the models."** Assisty is a custom cloud-native control plane, **not** a no-code workflow product wearing a SaaS costume:

- A **stateless NestJS edge** on Cloud Run / Fly.io / Railway (a long-lived Node process, **not** a Supabase Edge Function) receives one shared inbound webhook for *all* tenants, verifies it, and returns `200` in ~50 ms — doing **zero** LLM work inline.
- A **durable Supabase Queues (pgmq) + pg_cron** layer decouples receipt from processing so a traffic spike or a slow model never drops a message. (Upstash Redis + BullMQ is the kept-on-file alternative if richer queue semantics are ever needed.)
- A **NestJS AI worker fleet** is the brain's executor: it resolves the tenant, sets RLS scope, checks the spend cap *before* spending, runs RAG, calls the model through a gateway, applies guardrails, writes the reply, and meters usage.
- **Supabase Postgres 16 with pgvector** is the *single* system of record — relational data **and** the vector index live in one store under **one** Row-Level-Security model.
- **LiteLLM Proxy** is the swappable model gateway: per-tenant virtual keys give revocable, budgeted, model-restricted access with automatic 429/500 fallback.

Three priorities drive every decision, **in this order**:

| # | Priority | What it buys |
|---|----------|--------------|
| 1 | **Hard per-tenant isolation & token security** | No cross-tenant leak is the existential risk for multi-tenant SaaS. Defense in depth (six layers, see §6). |
| 2 | **Predictable horizontal scale on managed primitives** | A solo team can run it: managed Supabase (Postgres, Auth, Storage, Queues, Realtime) plus a long-lived Node host (Cloud Run / Fly.io / Railway) — no Kubernetes, no self-hosted GPUs, no Temporal until forced. |
| 3 | **Cost control via an internal usage ledger** | Caps enforced *before* the LLM call, not after Stripe — the antidote to runaway per-resolution bills. |

**The single most important architectural verdict: n8n is NOT the brain.** Both the competitive and the architecture research converged on this. n8n's AI Agent node makes 2–4 LLM calls per query, its memory nodes do **not** isolate per tenant (a hard security failure for us), concurrency is fixed at startup, and production response times of **16 s+** have been reported. n8n is permitted only as (a) an *optional internal* ingestion/ops tool and (b) a *customer-facing outbound* integration — **never on the live customer turn.** See [`AI-ORCHESTRATION.md`](./AI-ORCHESTRATION.md).

**Cost & timeline at a glance:** ~$900–1,500/month infra at ~50 active tenants (excludes pass-through LLM + WhatsApp costs, which tenants effectively fund). MVP target: **15 weeks.**

---

## 2. Product Vision

> **Differentiate on transparency and spend caps, not on having "an AI."** Everyone has an AI now.

Assisty wins on three claims a competitor finds hard to copy:

1. **Zero messaging markup.** We register as a **Meta Tech Provider** (not a BSP). Each tenant attaches *their own* payment method to WhatsApp, so Meta bills them directly for messages and Assisty bills software only. Combined with Google Play's cloud-business-software exemption (all checkout flows live on the web, never in the Android binary), Assisty pays **no Google service fee** and **no WhatsApp markup**. That is a structural margin advantage, not a promo.
2. **No surprise bills.** An **internal Postgres usage ledger is the source of truth** for hard caps and is checked *pre-flight*, before any model call. Stripe meters are for invoicing only — a Stripe lag can never cause an overspend. This is the explicit antidote to Intercom-Fin-style uncapped per-resolution pricing.
3. **Grounded, model-transparent answers.** Each tenant's bot is grounded in that tenant's own knowledge base via RAG, picks its own model per plan, and we **lead with a clear model claim** — we do not hide behind an unnamed model, and we do not mark up pass-through API costs (no thin-GPT-wrapper-at-markup trap).

**Surface stance — hybrid is the sweet spot.** The default surface is an **LLM-native agent**. A deterministic **visual flow builder** for commerce guardrails (the Chatfuel/Botpress pattern) is a *roadmap* item, not MVP. Pure-flow feels dated; pure-LLM lacks commerce guardrails.

**Channel stance — table stakes plus what we control.**

| Channel | MVP? | Why |
|---------|------|-----|
| WhatsApp Cloud API | ✅ Yes | The flagship channel; Cloud API only (On-Prem EOL 2025-10-23). |
| Web widget | ✅ Yes | Fully under our control; no third-party review gate. |
| Email | ✅ Yes | Fully under our control (Mailgun Routes / SendGrid Inbound Parse). |
| Instagram DM + Messenger | ⏳ Post-launch | Feasible (shared Graph API) but gated by Meta App Review + Business Verification (weeks–months). Must **not** block MVP. |
| TikTok DM | ❌ Out of scope | No open API, partner-gated, geo-blocked for US/EEA/UK/CH. **Do not promise it.** |

MVP rides on **WhatsApp + web widget + email** precisely because Instagram/Messenger approval timing is outside our control.

---

## 3. The Chosen Architecture and Why It Won

Three candidates were designed and stress-tested. The winner is **Custom Cloud-Native**. Here is the honest comparison and the reasoning.

| Dimension | C1 — Firebase-Native | **C2 — Custom Cloud-Native (WINNER)** | C3 — n8n-Orchestrated Hybrid |
|-----------|----------------------|----------------------------------------|------------------------------|
| Runtime brain | Cloud Functions | **NestJS worker on Cloud Run / Fly.io / Railway** | n8n flows (live turn) |
| System of record | Firestore | **Supabase Postgres + pgvector** | Postgres core + n8n |
| Tenant isolation | Firestore rules (Admin SDK bypasses!) | **RLS + FORCE RLS + Vault/pgsodium + app-level per-tenant key** | n8n credential scoping ("good enough") |
| Metering fit | Per-op pricing, unpredictable | **Relational ledger, exact caps** | Split across planes |
| Ops burden (solo team) | Lowest | **Moderate, managed primitives** | Two control planes to run |
| Live-turn latency | Good | **Good (async hop, well under 16 s)** | **16 s+ reported — disqualifying** |
| MVP weeks | Fastest | **15** | Medium |

### Why C2 won

1. **Isolation is priority #1, and only C2 delivers defense in depth.** Firestore security rules are *bypassed by the Admin SDK*, so a server bug leaks across tenants; n8n's memory nodes do not isolate per tenant at all. C2 stacks **six independent isolation layers** (§6) so a single forgotten `WHERE` clause cannot leak data.
2. **The domain is relational and metering-heavy.** Tenants, channels, conversations, messages, a usage ledger, an audit log — this is a relational, transactional, cap-enforcing workload. Firestore's per-op pricing is unpredictable at messaging scale and locks you in. The research brief is explicit: **Postgres as system of record, NOT Firestore.**
3. **One stateful store, one security model.** Choosing **pgvector over Qdrant** for the MVP is deliberate: it collapses relational data *and* vectors into one store under one RLS model, with one backup/PITR story. A separate vector DB doubles the isolation surface a small team must secure. Qdrant is a documented swap-in *behind the same Retriever interface* when volume/latency demands it — not before.
4. **n8n-as-brain is an anti-pattern (C3 disqualified for the live turn).** 16 s+ responses, no per-tenant memory isolation, fixed concurrency. C3's *good* idea — n8n as the async/ingestion + outbound-integration plane — is grafted into C2's roadmap instead (§4, ingestion).
5. **Managed primitives keep a solo team alive.** A long-lived Node host (Cloud Run / Fly.io / Railway) plus managed Supabase (Postgres, Auth, Storage, Queues/pgmq + pg_cron, Realtime, Vault) — no Kubernetes, no self-hosted frontier models, no Temporal until a real long-running-handoff use case forces it. The backend platform choice is recorded in [`docs/ADR-0002-supabase-backend.md`](./docs/ADR-0002-supabase-backend.md).

### Ideas grafted in from the losing candidates

- **From C1:** A first-class **Retriever interface** *and* a **repository/data-access layer** so the store is swappable. The pgvector→Qdrant migration and any Supabase Postgres read-replica/sharding move are a **bounded blast radius by design, not a retrofit.**
- **From C1:** **Cost discipline on the always-on floor** — `min-instances=1` strictly on the **webhook edge** and the **AI worker**; let ingestion/embedding/billing-meter workers scale to zero.
- **From C1:** **Structural tenant partitioning of vectors** as a layer *on top of* RLS — lead every index/filter with `tenant_id`, and add an automated test proving a query with no `app.tenant_id` set **returns zero rows** (turn structural isolation into an enforced invariant).
- **From C1:** **Minimal-glue client wiring** — Supabase Auth (JWT identity) + FCM (push only) to claw back dev speed; RLS policies read the tenant from a custom JWT claim (`auth.jwt() ->> 'tenant_id'`).
- **From C3:** **n8n as the ingestion/re-embedding + customer-facing outbound plane only**, with the hardening rule that the **Core API re-validates and re-stamps `tenant_id` on every write originating from any less-trusted plane.**
- **From C3:** **Langfuse** for per-turn LLM tracing (prompt, retrieved chunks, token/cost per tenant) alongside Cloud Trace/OTel.
- **From C3:** **n8n admin behind SSO + VPC, no public webhook exposure** for any internal ops tooling.

### Honest cons we accept (and the mitigation)

| Con | Mitigation |
|-----|------------|
| More moving parts than a monolith | All managed; documented runbooks in [`OPERATIONS.md`](./OPERATIONS.md). |
| Supabase `service_role` bypasses RLS (the same flaw that disqualified Firebase) | Edge and AI worker **never** use `service_role` for tenant data — a dedicated tenant-scoped non-superuser role with RLS enforced, `SET LOCAL app.tenant_id` per txn, via the Supavisor pooler in transaction mode; see [`SECURITY.md`](./SECURITY.md) and [`docs/ADR-0002-supabase-backend.md`](./docs/ADR-0002-supabase-backend.md). |
| pgvector underperforms a dedicated engine at tens of millions of vectors | Retriever interface → Qdrant swap; see [`DATA-MODEL.md`](./DATA-MODEL.md). |
| Embedding model is immutable per index — tier change = full per-tenant re-embed | Pin embedding model per tier; ingest pipeline owns re-embed; see [`INGESTION-RAG.md`](./INGESTION-RAG.md). |
| Self-hosted LiteLLM is on the AI hot path | Run HA (`min-instances ≥ 1`, health checks); see [`AI-ORCHESTRATION.md`](./AI-ORCHESTRATION.md). |
| Async hop adds a latency floor | Warm workers + queue-depth alarms keep p95 low; see [`OBSERVABILITY.md`](./OBSERVABILITY.md). |
| Instagram/Messenger gated by Meta review | MVP rides WhatsApp + widget + email; see [`CHANNELS.md`](./CHANNELS.md). |
| Always-on warm floor cost | Scale-to-zero on cold-tolerant workers; see [`BILLING-AND-COST.md`](./BILLING-AND-COST.md). |

---

## 4. High-Level Component Diagram

```
                                        ┌──────────────────────────────────────────────┐
   Customer channels                    │           COMPUTE HOST + SUPABASE              │
   (per tenant's own accounts)          │     (Cloud Run / Fly.io / Railway + Supabase)  │
                                        │   ┌────────────────────────────────────────┐   │
  WhatsApp ─┐                           │   │  Load Balancer + WAF                     │   │
  Instagram ┤                           │   └───────────────────┬────────────────────┘   │
  Messenger ┼──── inbound msg ──────────┼──────────────────────►│                         │
  Web widget┤   (one shared URL)        │   ┌───────────────────▼────────────────────┐   │
  Email ────┘                           │   │  API GATEWAY / EDGE  (NestJS, long-lived │   │
                                        │   │  Node: Cloud Run / Fly.io / Railway)     │   │
                                        │   │  synchronous, stateless, min-instances=1 │   │
                                        │   │  • HMAC verify (X-Hub-Signature-256)     │   │
                                        │   │  • resolve tenant by phone_number_id     │   │
                                        │   │  • dedupe wamid (unique constraint +     │   │
                                        │   │    idempotency table)                    │   │
                                        │   │  • return 200 in ~50ms, enqueue job      │   │
                                        │   │  • REST CRUD + Realtime for dashboard    │   │
                                        │   └───────┬───────────────────────┬─────────┘   │
                                        │           │ enqueue               │ Realtime     │
                                        │   ┌───────▼───────────────────────┼─────────┐   │
                                        │   │  SUPABASE QUEUES (pgmq) + pg_cron     │   │
                                        │   │  queues:                              │   │
                                        │   │  inbound-messages · ai-turn ·         │   │
                                        │   │  embeddings/ingest · outbound-send ·  │   │
                                        │   │  billing-meter · reembed · re-sync    │   │
                                        │   │  crawl   |  pg_cron schedules ·       │   │
                                        │   │  Realtime (Postgres CDC over WS)      │   │
                                        │   └───────┬───────────────────────────────┘   │
                                        │           │ ai-turn jobs                        │
                                        │   ┌───────▼─────────────────────────────────┐   │
                                        │   │  AI WORKER FLEET  (NestJS, long-lived    │   │
                                        │   │  Node: Cloud Run / Fly.io / Railway)     │   │
                                        │   │  THE BRAIN'S EXECUTOR (min-instances=1)  │   │
                                        │   │  tenant-scoped non-superuser role; NEVER │   │
                                        │   │  service_role; Supavisor txn-mode pooler │   │
                                        │   │  SET LOCAL app.tenant_id → RLS scope     │   │
                                        │   │  pre-flight CAP CHECK (usage_ledger)     │   │
                                        │   │  RAG → prompt → model → guardrails       │   │
                                        │   │  LangGraph ONLY for cyclic multi-tool    │   │
                                        │   └──┬────────────┬───────────┬───────┬─────┘   │
                                        │      │            │           │       │          │
                                        │      │ embed/chat │ read/write│ wrap  │ meter    │
                                        │  ┌───▼────────┐ ┌─▼──────────▼──┐ ┌──▼────────┐ │
                                        │  │ MODEL GW   │ │ SUPABASE PG16  │ │ SB VAULT  │ │
                                        │  │ LiteLLM    │ │ + pgvector(HNSW)│ │ pgsodium  │ │
                                        │  │ (long-lived│ │ SYSTEM OF      │ │ AEAD + app │ │
                                        │  │  Node host)│ │ RECORD + VECTOR│ │ per-tenant │ │
                                        │  │ per-tenant │ │ RLS+FORCE RLS  │ │ AES-256-GCM│ │
                                        │  │ virtual    │ │ on every table │ │ (crypto-   │ │
                                        │  │ keys, FBack│ │ Supavisor pool │ │ shred)     │ │
                                        │  └──┬─────────┘ └────────────────┘ └───────────┘ │
                                        │     │ egress                                      │
                                        │  ┌──▼──────────────┐    ┌──────────────────────┐ │
   OpenAI / Gemini / Anthropic ◄───────┼──┤ hosted LLM APIs │    │ Stripe Billing Meters │ │
                                        │  └─────────────────┘    │ (async, invoicing)    │ │
                                        │                          └──────────────────────┘ │
                                        │   ┌─────────────────────────────────────────────┐ │
   Tenant operator ── REST/Realtime ────┼──►│ MOBILE/WEB CLIENT  Flutter+Riverpod2 (dash) │ │
   (Flutter app)        FCM push        │   │ Supabase Auth (JWT identity) · FCM · Drift   │ │
                                        │   └─────────────────────────────────────────────┘ │
                                        │   ┌─────────────────────────────────────────────┐ │
                                        │   │ INGESTION PLANE  pgmq + pg_cron → worker    │ │
                                        │   │ chunk → embed (LiteLLM) → pgvector upsert   │ │
                                        │   │ source files in Supabase Storage            │ │
                                        │   │ n8n ALLOWED here (internal) + OUTBOUND only │ │
                                        │   └─────────────────────────────────────────────┘ │
                                        │   OBSERVABILITY: Cloud Logging/Trace/Monitoring  │ │
                                        │   + OpenTelemetry + Langfuse + hash-chained      │ │
                                        │   append-only audit_log (no tokens/PII ever)     │ │
                                        └──────────────────────────────────────────────────┘
```

**Component responsibilities (one-line each):**

| Component | Tech | Role |
|-----------|------|------|
| Edge / API Gateway | NestJS (Node 20, Fastify) on Cloud Run / Fly.io / Railway (long-lived Node, **not** Supabase Edge Functions), `min-instances=1`, concurrency 80; LB + WAF | Synchronous edge: auth, REST, onboarding, the one shared webhook, Realtime. **No inline LLM calls.** |
| Inbound Queue | Supabase Queues (pgmq) + pg_cron | Durable decoupling: retries, DLQ, per-tenant rate-limit groups, `wamid` idempotency (unique constraint + idempotency table). Upstash Redis + BullMQ kept on file as the richer-semantics alternative. |
| AI Worker Fleet | NestJS worker on Cloud Run / Fly.io / Railway (long-lived Node), `min-instances=1`; LangGraph for cyclic paths | The brain's executor: RLS scope, cap check, RAG, model call, guardrails, ledger write. Connects via Supavisor (transaction mode) as a tenant-scoped non-superuser role — **never** `service_role`. |
| Model Gateway | LiteLLM Proxy (self-hosted on the long-lived Node host, HA) | Single LLM/embedding egress; per-tenant virtual keys; auto 429/500 fallback. |
| System of Record + Vectors | Supabase Postgres 16 + pgvector (HNSW) | One store for all relational data **and** vectors, one RLS model. |
| Queue / Realtime / Scheduling | Supabase Queues (pgmq), Realtime (Postgres CDC over WebSocket), pg_cron | Async work backing, live dashboard push (SSE fallback), scheduled jobs (KB website re-sync). |
| Key Mgmt / Secrets | Supabase Vault (pgsodium AEAD, per-DB root key) + app-level per-tenant AES-256-GCM | Vault encrypts secrets at rest; per-tenant app key enables crypto-shredding; platform secrets. |
| Channel Connectors | Per-channel adapters behind one Channel interface | Inbound normalize → canonical message; outbound render → channel API. |
| Ingestion / Knowledge | pgmq + pg_cron → worker; files in Supabase Storage (n8n optional) | Docs → chunk → embed → tenant-scoped pgvector upsert; re-embed on tier change. |
| Billing + Metering | Stripe Billing + Meters API; internal `usage_ledger` | Meter `messages_sent`/`ai_tokens`; enforce caps *before* work; invoice. |
| Mobile / Web Client | Flutter + Riverpod 2, GoRouter, Dio, Drift, FCM, Supabase Auth | Tenant dashboard; connect channels; live conversations; usage/spend; web-link billing. |
| Observability + Audit | Cloud Logging/Trace/Monitoring, OTel, Langfuse, `audit_log` | End-to-end traces, queue/latency/cap alerts, tamper-evident audit trail. |

---

## 5. End-to-End Request Lifecycle

A single inbound customer message, traced from arrival to logged reply. This is the canonical flow; [`AI-ORCHESTRATION.md`](./AI-ORCHESTRATION.md) and [`SECURITY.md`](./SECURITY.md) expand the boxed-off concerns.

```
[1] INBOUND  ── customer sends a WhatsApp message
       │
       ▼
   POST /webhooks/whatsapp   (ONE shared URL for ALL tenants, hits the Edge)
       │
   ┌───┴─────────────────────────────────────────────────────────────┐
   │ EDGE (synchronous, no LLM work):                                  │
   │  a. read RAW body; verify X-Hub-Signature-256 (HMAC-SHA256,       │
   │     constant-time compare, 5-min timestamp tolerance)             │
   │  b. extract phone_number_id / waba_id → RESOLVE TENANT            │
   │     (NEVER trust a tenant_id from the body)                       │
   │  c. dedupe on wamid via Postgres unique constraint + idempotency  │
   │     table (Meta redelivers)                                       │
   │  d. return 200 in ~50ms                                           │
   │  e. enqueue normalized job → pgmq `inbound-messages`              │
   └───┬───────────────────────────────────────────────────────────────┘
       │  (async hop — webhook thread is now free)
       ▼
[2] ROUTING  ── worker pulls job, opens a Postgres transaction
       │
   SET LOCAL app.tenant_id = <resolved tenant>   ← per-txn, NEVER plain SET
       │     (RLS now scopes EVERY query in this transaction)
       ▼
   load tenant config (model, tone, plan, caps) + recent conversation
   memory + open-24h-window state  (Postgres; optional hot cache)
       │
       ▼
[3] PRE-FLIGHT CAP CHECK  ── read internal usage_ledger
       │
       ├── OVER hard cap? ──► short-circuit to templated "limit reached"
       │                       reply.  NO model call.  (caps before spend)
       │
       ▼ under cap
[4] RAG RETRIEVAL
       │  embed the user query via LiteLLM (tenant's virtual key)
       │  pgvector HNSW similarity search:
       │    WHERE tenant_id = current_setting('app.tenant_id')   (RLS = backstop)
       │  → top-k chunks from THIS tenant's knowledge base
       ▼
[5] AI TURN  (via Model Gateway / LiteLLM)
       │
       ├── simple Q&A: ONE LiteLLM chat call to tenant's model
       │               (system prompt + RAG context + memory)
       │
       └── commerce / multi-tool: LangGraph bounded cyclic loop
                 get_order → check_inventory → reply
                 ┌──────────────────────────────────────────────┐
                 │ GUARDRAIL / ISOLATION (critical):              │
                 │ tenant_id is INJECTED SERVER-SIDE into every   │
                 │ tool call from the resolved session.           │
                 │ The model is NEVER asked to supply it.         │
                 └──────────────────────────────────────────────┘
       │  (LiteLLM auto-falls-back on 429/500/timeout)
       ▼
[6] OUTBOUND  ── in the SAME RLS transaction:
       │  • write message row (the reply)
       │  • increment usage_ledger (tokens + message count)
       │  • append hash-chained audit_log entry (no tokens/PII)
       │  enqueue → pgmq `outbound-send`
       ▼
   channel connector renders + calls channel API (WhatsApp send / widget push),
   respecting 24h-window rules (free-form service inside window; template outside)
       ▼
[7] LOGGING & METERING
       │  • enqueue → pgmq `billing-meter` → Stripe Billing Meters API (async)
       │  • Langfuse records prompt + retrieved chunks + token/cost per tenant
       │  • live dashboard sees the turn via Supabase Realtime (SSE fallback)
       ▼
   DONE
```

**Latency budget (illustrative target, p95):** Edge `200` ≤ 50 ms · queue hop + worker warm-up ≤ 150 ms · embed + pgvector search ≤ 200–500 ms · LLM call 1–3 s · outbound send ≤ 300 ms. The async hop adds overhead versus an inline call but stays **far under n8n's 16 s+** — *provided* `min-instances=1` keeps the edge and worker warm. Queue-depth and LLM-latency alarms are mandatory; see [`OBSERVABILITY.md`](./OBSERVABILITY.md).

---

## 6. Per-Tenant Isolation — Defense in Depth

This is priority #1. **No single mechanism is trusted alone.** The full threat model and the SQL/role setup live in [`SECURITY.md`](./SECURITY.md); the layers, summarized:

| # | Layer | Mechanism | What it stops |
|---|-------|-----------|---------------|
| a | **RLS + FORCE ROW LEVEL SECURITY** on every tenant table | App connects as a **non-owner, non-superuser, no-BYPASSRLS** role (**never** Supabase `service_role`, which bypasses RLS); `SET LOCAL app.tenant_id` per transaction (**never** plain `SET` — leaks across pooled connections); via the Supavisor pooler in transaction mode. RLS policies that key off the JWT read the tenant from a custom claim (`auth.jwt() ->> 'tenant_id'`). | A query that forgets to filter still returns only the current tenant's rows. |
| b | **Tenant-led indexes** | Every index leads with `tenant_id` | Performance *and* a structural partition boundary. |
| c | **pgvector queries tenant-filtered** + per-tenant partition convention | Explicit `WHERE tenant_id = current_setting(...)` on top of RLS | RAG cannot retrieve another tenant's chunks. **Enforced invariant:** an automated test proves a query with no `app.tenant_id` set returns **zero rows**. |
| d | **Server-injected `tenant_id` in all tool calls** | Worker stamps `tenant_id` from the resolved session into every tool/function call | The **top cross-tenant leak vector** — the model is never trusted to supply it. |
| e | **Per-tenant encryption boundary (Bridge model)** | Channel tokens protected by **Supabase Vault (pgsodium AEAD, per-DB root key)** at rest, **plus** an app-level **per-tenant AES-256-GCM** layer; store only ciphertext + IV/tag, with the per-tenant app key held outside the row | A leaked database dump is useless without the per-tenant app key; deleting that key **crypto-shreds** the tenant's data for GDPR erasure. |
| f | **Per-tenant LiteLLM virtual keys** | Revocable, budgeted, model-restricted keys | Caps and isolates each tenant's model spend; one tenant cannot burn another's budget. |

**Cross-cutting hardening rule (grafted from C3):** any write originating from a *less-trusted* plane — ingestion jobs, batch re-embed, future n8n flows — is **re-validated and re-stamped with `tenant_id` by the Core API**, even though RLS already backstops it.

> **⚠️ Load-bearing Supabase warning.** Supabase's `service_role` **bypasses RLS** — the same flaw that disqualified Firebase (Admin SDK bypass). The edge and AI worker **MUST** use a dedicated **tenant-scoped, non-superuser role with RLS enforced** and **`SET LOCAL app.tenant_id` per transaction**, and **NEVER** `service_role` for tenant data. Connect through Supabase's pooler (**Supavisor**) in **transaction mode**. The backend platform decision is recorded in [`docs/ADR-0002-supabase-backend.md`](./docs/ADR-0002-supabase-backend.md).

---

## 7. How the Docs Fit Together

`ARCHITECTURE.md` (this file) is the **entry point and the contract.** Each doc below owns one slice and must not contradict the winning architecture. Read order for a new builder: top to bottom.

```
docs/
├── ARCHITECTURE.md          ◄── YOU ARE HERE — the map + the contract
│
├── ADR-0002-supabase-backend.md   the backend platform decision: Supabase
│                            (Postgres/Auth/Storage/Queues/Realtime/Vault) + host
├── SECURITY.md              tenancy, RLS roles (no service_role), Vault +
│                            per-tenant app-key encryption, webhook HMAC,
│                            audit log, GDPR erasure (P0)
├── DATA-MODEL.md            Supabase Postgres schema, tenant tables, usage_ledger,
│                            pgvector setup, repository layer, Qdrant escape hatch
├── AI-ORCHESTRATION.md      the live turn, LiteLLM virtual keys, LangGraph,
│                            n8n verdict, RAG + memory, model routing
├── 08-knowledge-base.md     KB ingestion + website re-sync (pg_cron), Supabase
│                            Storage uploads, chunk/embed/upsert pipeline
├── INGESTION-RAG.md         chunking, embeddings, re-embed on tier change,
│                            pgmq + pg_cron vs n8n ingestion plane
├── CHANNELS.md              WhatsApp Embedded Signup, IG/Messenger, web widget,
│                            email; the Channel interface; 24h-window rules
├── BILLING-AND-COST.md      Stripe Billing Meters, the ledger as source of truth,
│                            Play exemption, Meta Tech Provider, cost model
├── OBSERVABILITY.md         Cloud Trace/Monitoring, OTel, Langfuse, queue alarms
├── OPERATIONS.md            deploy, min-instances policy, HA, runbooks, DR/PITR
└── CLIENT-APP.md            Flutter + Riverpod 2, Supabase Auth (identity only),
                             FCM, Drift, Realtime dashboard, web-link checkout
```

**Dependency / consistency map** — which docs constrain which:

| This doc… | …is constrained by | …and elaborates |
|-----------|---------------------|------------------|
| [`SECURITY.md`](./SECURITY.md) | §6 isolation layers | The full SQL, role/`service_role` policy, Vault + per-tenant app-key encryption, and threat model. |
| [`DATA-MODEL.md`](./DATA-MODEL.md) | §3 (one store), §6 (RLS) | Schema, indexes, Retriever/repository interfaces, Qdrant swap. |
| [`AI-ORCHESTRATION.md`](./AI-ORCHESTRATION.md) | §1 (n8n verdict), §5 (lifecycle) | Prompt assembly, LangGraph paths, fallback, memory keying. |
| [`08-knowledge-base.md`](./docs/08-knowledge-base.md) | §3 (embedding immutability), §6 (re-stamp rule) | KB uploads to Supabase Storage, website re-sync via pg_cron, chunk/embed/upsert. |
| [`INGESTION-RAG.md`](./INGESTION-RAG.md) | §3 (embedding immutability), §6 (re-stamp rule) | Chunking strategy, re-embed pipeline. |
| [`CHANNELS.md`](./CHANNELS.md) | §2 (channel stance), §5 (webhook) | Per-channel onboarding + send semantics. |
| [`BILLING-AND-COST.md`](./BILLING-AND-COST.md) | §2 (transparency), §1 (caps) | Meters, ledger, plans, cost breakdown. |
| [`OBSERVABILITY.md`](./OBSERVABILITY.md) | §5 (latency budget) | Traces, dashboards, alarms. |
| [`OPERATIONS.md`](./OPERATIONS.md) | §3 cons (warm floor, HA) | Deploy + runbooks + DR. |
| [`CLIENT-APP.md`](./CLIENT-APP.md) | §2 (Play exemption) | App wiring, web-link checkout. |

> **Rule for downstream authors:** if your doc needs to diverge from this overview, propose the change *here first*. The overview is the single source of truth for cross-cutting decisions.

---

## 8. Glossary

| Term | Definition |
|------|------------|
| **Tenant** | A business customer of Assisty. The hard isolation boundary for all data, tokens, vectors, and spend. |
| **Edge / API Gateway** | The stateless NestJS Cloud Run service that terminates HTTP, verifies webhooks, and enqueues work. Does no LLM work. |
| **AI Worker** | The NestJS Cloud Run service that pulls `ai-turn` jobs and executes the brain (RLS scope, cap check, RAG, model call, guardrails). |
| **Supabase Queues (pgmq)** | Postgres-native durable job queue that decouples webhook receipt from processing; provides retries, DLQ, idempotency. Drives ingest, reembed, re-sync crawl, outbound-send, billing-meter. Upstash Redis + BullMQ is the kept-on-file alternative for richer queue semantics. |
| **pg_cron** | In-database job scheduler that runs scheduled work (e.g. Knowledge Base website re-sync) and drives pgmq queue processing. |
| **Supavisor** | Supabase's connection pooler; the edge and AI worker connect through it in **transaction mode** as a tenant-scoped non-superuser role (never `service_role`). |
| **LiteLLM Proxy** | Self-hosted model gateway; single egress for all LLM/embedding traffic; issues per-tenant virtual keys with budgets and fallback. |
| **Virtual key** | A per-tenant LiteLLM credential — revocable, budgeted, model-restricted — so a tenant uses only its allowed model and budget. |
| **pgvector** | Postgres extension giving vector columns + HNSW index, so RAG vectors live in the same store as relational data. |
| **HNSW** | Hierarchical Navigable Small World — the approximate-nearest-neighbor index used by pgvector for similarity search. |
| **RAG** | Retrieval-Augmented Generation — retrieve the tenant's top-k knowledge chunks and inject them as grounding context for the model. |
| **RLS / FORCE RLS** | Postgres Row-Level Security; FORCE applies it even to the table owner. The backstop that scopes every query to one tenant. |
| **`SET LOCAL app.tenant_id`** | Per-transaction setting that drives RLS. Must be `SET LOCAL`, never plain `SET`, to avoid leaking across pooled connections. |
| **Supabase Vault / pgsodium** | Supabase's in-database secret store using pgsodium AEAD encryption under a per-DB root key; encrypts secrets at rest. Layered *under* the app-level per-tenant key. |
| **Per-tenant app key (AES-256-GCM)** | An application-managed AES-256-GCM key, one per tenant, layered on top of Vault so each tenant's data can be crypto-shredded independently. |
| **Crypto-shredding** | GDPR erasure by destroying a tenant's per-tenant app key, rendering all that tenant's encrypted data permanently unrecoverable. |
| **Bridge model** | The tenancy posture: pooled shared DB with hard logical isolation, where the *encryption-key boundary* is siloed per tenant. |
| **`usage_ledger`** | The internal Postgres table that is the **source of truth** for hard spend caps; checked pre-flight before any model call. |
| **Billing Meters API** | Stripe's current usage-metering API (legacy usage records deprecated); reports `messages_sent` and `ai_tokens` for invoicing only. |
| **Meta Tech Provider** | Meta partner status (not a BSP) letting each tenant attach its own payment method to WhatsApp → zero messaging markup. |
| **Embedded Signup** | Meta's `FB.login` onboarding flow returning a `code` + `WA_EMBEDDED_SIGNUP` payload (`waba_id`, `phone_number_id`). |
| **`waba_id` / `phone_number_id`** | WhatsApp Business Account ID / phone number ID — extracted from the webhook payload to resolve the tenant. |
| **`wamid`** | WhatsApp message ID; the idempotency key used to dedupe Meta's webhook redeliveries (Postgres unique constraint + idempotency table). |
| **24h window** | WhatsApp's customer-service window: free-form service replies are free inside it; templates (and marketing/auth) apply outside. |
| **Supabase Realtime** | Postgres change-data-capture (CDC) streamed over WebSocket; the primary live-dashboard transport. |
| **SSE** | Server-Sent Events — retained as a **fallback** transport for live dashboards where Realtime/WebSocket is unavailable. |
| **`service_role`** | Supabase's privileged key that **bypasses RLS**. **Never** used for tenant data by the edge or AI worker — the same bypass flaw that disqualified Firebase's Admin SDK. |
| **LangGraph** | A graph-based agent framework pulled in **only** for the cyclic multi-tool commerce path; simple Q&A stays a single linear call. |
| **Temporal** | A durable-workflow engine; **explicitly deferred** — used only if a real long-running async (hours-long handoff) use case forces it. |
| **n8n** | A workflow automation tool. **Not the brain.** Permitted only as an internal ingestion/ops tool and as customer-facing outbound integrations. |
| **Retriever interface** | The abstraction over vector retrieval; lets pgvector be swapped for Qdrant later with a bounded blast radius. |
| **Repository layer** | The data-access abstraction over Postgres; bounds the blast radius of read-replica/sharding or store migrations. |
| **Langfuse** | LLM-specific observability — per-turn prompt, retrieved chunks, and token/cost attribution per tenant — alongside Cloud Trace/OTel. |
| **`audit_log`** | A tamper-evident, hash-chained, append-only table for security + GDPR; never stores tokens or PII. |
| **Supabase / Cloud Run (or Fly.io / Railway)** | Managed primitives: Supabase provides Postgres + pgvector, Auth, Storage, Queues (pgmq), Realtime, and Vault; a long-lived Node host (Cloud Run / Fly.io / Railway) runs the edge + AI worker — the no-Kubernetes operability bet. |

---

*End of overview. Proceed to [`SECURITY.md`](./SECURITY.md) and [`DATA-MODEL.md`](./DATA-MODEL.md) next — they implement priority #1.*
