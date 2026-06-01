# Tech Stack, Repo Structure & Phased Roadmap

> **Project:** Assisty — multi-tenant AI customer-service SaaS
> **Local root:** `D:/Assisty`
> **Authoritative architecture:** *Assisty Custom Cloud-Native* — NestJS + Cloud Run/Fly.io/Railway + Supabase Postgres/pgvector + Supabase Queues (pgmq) + LiteLLM.
> **Backend platform decision:** see **ADR-0002** (`docs/ADR-0002-supabase-backend.md`).
> **One-line philosophy:** **Own the runtime, rent the models.** Custom stateless control plane (long-lived Node process) over a single Supabase Postgres; n8n is never the brain.
>
> This document is the build contract. It locks the consolidated stack, the repo layout you'll `mkdir` today, and a six-phase roadmap with exit criteria you can check off. It is opinionated on purpose — every "default" below is a decision you can ship against, not a menu.

---

## 1. Consolidated Tech Stack

Everything below is a **default with a stated reason**. Where there's a real fork (e.g. pgvector → Qdrant), the escape hatch is named and gated behind an interface so the swap is a contained blast radius, not a re-platform.

### 1.1 The stack at a glance

```
┌─────────────────────────────────────────────────────────────────────────┐
│  CLIENT          Flutter (Android + Web dashboard)                        │
│                  Riverpod 2 · GoRouter · Dio · Drift · FCM · Supabase Auth│
└───────────────┬───────────────────────────────────────────────────────────┘
                │  HTTPS / Realtime (live dashboard) · FCM data push (out-of-band)
┌───────────────▼───────────────────────────────────────────────────────────┐
│  EDGE (sync)     NestJS (Node 20, Fastify) on Cloud Run / Fly.io / Railway │
│                  min-instances=1 · concurrency 80 · Cloud LB + Cloud Armor │
│                  REST CRUD · shared webhook receiver · Realtime · key issue│
└───────────────┬───────────────────────────────────────────────────────────┘
                │  enqueue (returns 200 in ~50ms, ZERO LLM work inline)
┌───────────────▼───────────────────────────────────────────────────────────┐
│  QUEUE           Supabase Queues (pgmq) + pg_cron                          │
│   queues: inbound-messages · ai-turn · embeddings-ingest ·                 │
│           outbound-send · billing-meter   (retries · DLQ · idempotency)    │
└───────────────┬───────────────────────────────────────────────────────────┘
                │
┌───────────────▼───────────────────────────────────────────────────────────┐
│  WORKERS (async) NestJS worker fleet on Cloud Run / Fly.io / Railway       │
│                  AI turn · RAG · guardrails · LangGraph (commerce only)    │
│                  ingest / re-embed jobs (scale-to-zero)                    │
└──────┬───────────────────────────┬───────────────────────┬─────────────────┘
       │ LLM + embeddings          │ system of record       │ meter
┌──────▼─────────────┐  ┌──────────▼──────────┐  ┌──────────▼──────────────┐
│  LiteLLM Proxy     │  │ Supabase Postgres16 │  │ Stripe Billing          │
│  (long-lived, HA)  │  │  + pgvector (HNSW)  │  │  + Billing Meters API   │
│  per-tenant vkeys  │  │  RLS + FORCE RLS    │  │  (invoicing only)       │
│  → OpenAI/Gemini/  │  │  single store of    │  │  ledger = source of     │
│    Anthropic       │  │  record + vectors   │  │  truth for hard caps    │
└────────────────────┘  └─────────────────────┘  └─────────────────────────┘
       │
┌──────▼─────────────────────────────────────────────────────────────────────┐
│  CROSS-CUTTING   Supabase Vault (pgsodium AEAD) + app-level per-tenant     │
│                  AES-256-GCM (crypto-shred) · Cloud Logging/Trace + OTel · │
│                  Langfuse (LLM) · hash-chained append-only audit_log       │
└──────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Layer-by-layer decisions

#### Mobile / Web client (the operator app — NOT the end-customer chat)

| Concern | Pick | Why / decision |
|---|---|---|
| Framework | **Flutter** (one codebase → Android + Web dashboard) | Solo-team leverage; web build serves the live-conversation dashboard. |
| State | **Riverpod 2** (over Bloc) | Less boilerplate, compile-safe providers, easy to test the data layer. |
| Routing | **GoRouter** | Declarative, deep-link-friendly for `connect-channel` callback URLs. |
| HTTP | **Dio** | Interceptors for auth-token refresh + retry. |
| Offline cache | **Drift** | Local cache of conversations/usage for snappy UX. |
| Push | **FCM data messages** | Out-of-band notify ("new message", "cap at 80%"); not the live transport. |
| Identity | **Supabase Auth (identity ONLY)** | JWT-based; first-party glue claws back dev time. **Authorization is re-enforced server-side in Postgres via RLS — never trust the client.** RLS policies read the tenant from a custom JWT claim (`auth.jwt() ->> 'tenant_id'`). |
| Live updates | **Supabase Realtime** (Postgres CDC over WebSocket) | Tenant dashboards subscribe to row changes directly; SSE behind the LB stays a fallback if a long-lived edge stream is preferred. |
| Billing UI | **Web link out, never embedded** | Preserves the Google Play exemption (§5). The Android binary contains **zero** purchase flows. |

> **Grafted from Firebase-Native (C1):** lean hard on first-party Auth (now **Supabase Auth**) + FCM wiring (minimal glue) to recover dev speed against the 15-week estimate, while keeping the identity provider strictly identity/notification — not a datastore. (Firestore stays **rejected** as the system of record; the store of record is **Supabase Postgres**.)

#### Backend — synchronous edge

| Concern | Pick | Why |
|---|---|---|
| Runtime | **NestJS (Node 20), Fastify adapter** | Structured DI/modules keep the codebase navigable for a small team; Fastify for throughput on the hot webhook path. |
| Host | **Cloud Run / Fly.io / Railway**, `min-instances=1`, `concurrency=80` | A **long-lived Node process** (NOT Supabase Edge Functions — those are Deno, 150s-capped, light async/ingest only). `min-instances=1` kills cold starts **only on the hot path** (edge + AI worker) — cost discipline grafted from C1. |
| Edge | Cloud Load Balancer + **Cloud Armor** | WAF + IP/geo rules + rate-limit at the boundary. |
| Edge job | Auth, REST CRUD, **single shared webhook receiver**, Realtime, channel onboarding (WA code exchange, widget key issuance) | Edge does **no LLM work inline** — verifies HMAC, returns 200 fast, enqueues. |

#### Backend — async workers + queue

| Concern | Pick | Why |
|---|---|---|
| Queue | **Supabase Queues (pgmq) + pg_cron** | Durable in-Postgres queues, retries+backoff, DLQ, per-tenant rate-limit groups; idempotency via a Postgres **unique constraint** (e.g. unique `wamid`) + an **idempotency table** (not Redis `SETNX`). `pg_cron` drives scheduled async work. **Kept-on-file alternative:** Upstash Redis + BullMQ if richer queue semantics are needed. |
| Queues (separate) | `inbound-messages` · `ai-turn` · `embeddings-ingest` · `outbound-send` · `billing-meter` | Independent scaling + failure isolation per work type. |
| AI worker | **NestJS** worker = second long-lived service (Cloud Run / Fly.io / Railway), `min-instances=1` | The brain's executor: tenant config → memory → RAG → LLM → reply → ledger. |
| Batch / ingest | **scale-to-zero ingest jobs** (pg_cron-triggered) | Re-embed, doc ingest, admin batch — cold-start tolerant ⇒ no warm floor. |
| Cyclic reasoning | **LangGraph — commerce/multi-tool path only** | `get_order → check_inventory → reply`. Simple Q&A stays a single linear call (latency win). |
| Long-running async | **Temporal — explicitly deferred** | Not in MVP. Only when a real hours-long human-handoff use case forces it (Phase 5). |

> **Cost discipline (grafted from C1):** keep `min-instances=1` strictly on **edge + AI worker**. Let ingest/embedding/billing-meter workers and (where a cold-start fallback exists) the LiteLLM proxy scale toward zero to compress the always-on floor at low tenant counts.

#### AI brain & model gateway

| Concern | Pick | Why |
|---|---|---|
| Orchestration | **Custom stateless turn-service** (NestJS worker) | n8n's AI Agent node = 2–4 LLM calls/query, +200–500ms RAG, **16s+** prod times, no per-tenant memory isolation, fixed concurrency → **anti-pattern for live chat**. |
| Model gateway | **LiteLLM Proxy** (self-hosted long-lived service, **HA**) | Per-tenant **virtual keys**: revocable, budgeted, model-restricted; **auto-fallback on 429/500/timeout**; one egress point for cost logging. This is the "custom routing layer" without a self-hosted Llama-405B cascade. |
| Providers | OpenAI · Google Gemini · Anthropic (tenant picks GPT vs Gemini per plan) | Model freedom, no lock-in; a custom router model can slot behind the same interface later. |
| Embeddings | **`text-embedding-3-small`** (1536d, $0.02/1M) default · **`gemini-embedding-001`** quality tier (truncatable to 1536, Matryoshka) | **Embedding model is immutable per index** — pin per tenant tier; a tier change forces a per-tenant re-embed handled by the ingest pipeline. |
| LLM tracing | **Langfuse** alongside Cloud Trace/OTel | Per-turn prompt + retrieved chunks + token/cost **attributed per tenant** — materially better for RAG-quality debugging, spend-cap forensics, and prompt-injection detection than generic traces. |

> **n8n verdict (settled):** n8n is **never** the live turn. It is permitted only as (a) a customer-facing **outbound** integration a tenant wires up (Sheets/CRM/Slack), and (b) an optional **internal** ingestion/re-embed/ops tool. Default ingestion to **scale-to-zero ingest jobs (pg_cron-triggered)**; add n8n only if no-redeploy ingestion demand materializes (avoid the premature dual-ops tax).

#### Datastores

| Store | Pick | Role |
|---|---|---|
| System of record + vectors | **Supabase Postgres 16 + pgvector (HNSW, built-in)** | ONE relational store AND the RAG vector index under **one RLS security model, one backup/PITR story**. Domain is relational + metering-heavy; Firestore's per-op pricing is unpredictable at messaging scale (Firestore stays rejected). |
| Queue / realtime / rate-limit | **Supabase Queues (pgmq) + pg_cron** · **Supabase Realtime** | In-Postgres durable queues + scheduled jobs; Realtime (Postgres CDC) for dashboard fan-out. Hot tenant-config / conversation-state cache and token-bucket rate limiting live in-process / in-Postgres. **Kept-on-file:** Upstash Redis + BullMQ for richer queue semantics. |
| **Escape hatch (gated)** | **Qdrant** behind the `Retriever` interface | Swap in only when vector volume or p99 latency at high QPS demands it. The interface bounds the migration blast radius. |

> **Repository/Retriever discipline (grafted from C1 + Firebase-Native):** make the persistence boundary a **first-class abstraction**, not an afterthought. A thin `Retriever` interface (vector) and `*Repository` interfaces (relational) mean the pgvector→Qdrant swap and any read-replica/sharding move on Supabase Postgres are contained. **Enforced invariant:** an automated test proves a vector/relational query with **no `app.tenant_id` set returns zero rows** — turning "structural isolation" into a CI gate, not RLS trust.

#### Infra / hosting / security / observability

| Concern | Pick |
|---|---|
| Compute | Cloud Run / Fly.io / Railway (long-lived edge + worker services + ingest jobs) — no Kubernetes, no GPUs. The synchronous edge and AI worker are **long-lived Node processes**, NOT Supabase Edge Functions (Deno, 150s-capped, light async/ingest only). |
| DB role | **Dedicated tenant-scoped non-superuser role with RLS enforced** + `SET LOCAL app.tenant_id` per transaction. **NEVER `service_role` for tenant data** — Supabase `service_role` **bypasses RLS** (the same flaw that disqualified Firebase). Connect through Supabase's pooler (**Supavisor**) in **transaction mode**. |
| Secrets | **Secret Manager** (app/platform secrets) + least-privilege per-service **Service Accounts** |
| Key mgmt | **Supabase Vault (pgsodium AEAD, per-DB root key)** PLUS an **app-level per-tenant AES-256-GCM layer** for crypto-shred — deleting the per-tenant app key renders that tenant's ciphertext unrecoverable (GDPR erasure). |
| Edge security | Cloud Armor (WAF) + token-bucket rate limiting (tenant + user + endpoint) |
| Observability | Cloud Logging + Cloud Trace + Cloud Monitoring, **OpenTelemetry** from NestJS, **Langfuse** for LLM, hash-chained append-only `audit_log` |

> **Load-bearing security warning:** Supabase `service_role` **bypasses RLS** (the same flaw that disqualified Firebase) — the edge and AI worker **MUST** use a dedicated tenant-scoped **non-superuser** role with RLS enforced and `SET LOCAL app.tenant_id` **per transaction**, **NEVER** `service_role` for tenant data. Use Supabase's pooler (**Supavisor**) in **transaction mode**. (Backend platform rationale: **ADR-0002**, `docs/ADR-0002-supabase-backend.md`.)

#### CI/CD & tooling

| Concern | Pick | Why |
|---|---|---|
| Monorepo tool | **Nx** (or pnpm workspaces) | Affected-graph builds, shared TS libs across edge/worker, one lint/test config. |
| Containers | **Docker** per service → **Artifact Registry** | One Dockerfile per deployable; reproducible Cloud Run / Fly.io / Railway revisions. |
| CI/CD | **GitHub Actions → Cloud Build → Cloud Run / Fly.io / Railway** | PR: lint + typecheck + unit + the **tenant-isolation invariant test**. Merge to `main`: build, push, deploy to staging; tag → prod. |
| DB migrations | **Prisma Migrate** (or Drizzle) | Versioned schema; migration job runs pre-deploy. RLS policies + pgmq/pg_cron setup live in checked-in SQL migrations. |
| Flutter CI | GitHub Actions: `flutter test` + build web + Android AAB | Web dashboard auto-deploys; Android build is manual-gated to Play. |
| IaC | **Terraform** (`infra/`) | Compute (Cloud Run / Fly.io / Railway), Supabase project (Postgres, Vault, Queues/pg_cron, Realtime, Storage), Secret Manager, IAM, LB/Armor as code from day one. |
| Local dev | **docker-compose** (Supabase local stack — Postgres+pgvector+pgmq+pg_cron, LiteLLM, n8n) | One `docker compose up` = full local plane. |

---

## 2. Repo Structure — `D:/Assisty`

**Decision: a single Nx-managed monorepo.** One isolation model, one set of shared types, one CI graph. A solo/small team should not pay the cross-repo version-skew tax. Backend (TS) and the Flutter app coexist; the Flutter app is its own toolchain under `apps/operator-app`.

```
D:/Assisty
├─ apps/
│  ├─ edge/                      # NestJS sync edge (long-lived: Cloud Run/Fly/Railway)
│  │  ├─ src/
│  │  │  ├─ main.ts              # Fastify bootstrap, min-instances target
│  │  │  ├─ auth/                # Supabase Auth JWT verify → tenant resolve (jwt tenant_id)
│  │  │  ├─ webhooks/            # SINGLE shared receiver; HMAC verify + enqueue
│  │  │  │  ├─ whatsapp.controller.ts
│  │  │  │  ├─ meta-ig-messenger.controller.ts
│  │  │  │  └─ email-inbound.controller.ts
│  │  │  ├─ channels-onboarding/ # WA Embedded Signup code-exchange, widget keys
│  │  │  ├─ dashboard/           # REST CRUD for tenant dashboard
│  │  │  ├─ realtime/            # live-conversation Realtime (CDC) endpoint (SSE fallback)
│  │  │  └─ billing/             # Stripe checkout-link issuance (web only)
│  │  └─ Dockerfile
│  │
│  ├─ worker/                    # NestJS async worker fleet (Cloud Run/Fly/Railway)
│  │  ├─ src/
│  │  │  ├─ consumers/           # pgmq queue processors
│  │  │  │  ├─ inbound.consumer.ts
│  │  │  │  ├─ ai-turn.consumer.ts
│  │  │  │  ├─ outbound.consumer.ts
│  │  │  │  └─ billing-meter.consumer.ts
│  │  │  ├─ brain/               # the turn logic
│  │  │  │  ├─ rag/              # embed query → pgvector retrieve (tenant-filtered)
│  │  │  │  ├─ prompt/           # system prompt + tone + memory assembly
│  │  │  │  ├─ guardrails/       # commerce guardrails, tool registry
│  │  │  │  └─ graph/            # LangGraph (commerce multi-tool path ONLY)
│  │  │  ├─ cap-check/           # pre-flight usage_ledger hard-cap gate
│  │  │  └─ tools/               # tool impls — tenant_id INJECTED server-side
│  │  └─ Dockerfile
│  │
│  ├─ ingest/                    # scale-to-zero ingest job (pg_cron-triggered): chunk→embed→upsert
│  │  ├─ src/
│  │  │  ├─ chunker/             # doc/form → chunks
│  │  │  ├─ embedder/            # LiteLLM embeddings (tenant vkey)
│  │  │  └─ upsert/              # pgvector upsert with tenant_id RE-STAMPED
│  │  └─ Dockerfile
│  │
│  └─ operator-app/              # Flutter (Android + Web dashboard)
│     ├─ lib/
│     │  ├─ main.dart
│     │  ├─ core/                # Dio client, auth interceptor, env config
│     │  ├─ data/                # repositories + Drift cache (data-access layer)
│     │  ├─ features/
│     │  │  ├─ auth/             # Supabase Auth (identity only)
│     │  │  ├─ channels/         # connect WhatsApp/IG/widget/email
│     │  │  ├─ activation_form/  # business-info / agent-activation form
│     │  │  ├─ conversations/    # live Realtime dashboard (CDC; SSE fallback)
│     │  │  ├─ usage/            # spend/usage from ledger
│     │  │  └─ billing/          # opens web checkout link (NO IAP)
│     │  └─ providers/           # Riverpod 2 providers
│     ├─ pubspec.yaml
│     └─ test/
│
├─ libs/                         # shared TS libraries (Nx-linked)
│  ├─ contracts/                 # zod/DTOs + canonical Message type (edge↔worker↔app)
│  ├─ db/                        # Prisma schema, RLS policy SQL, repository interfaces
│  │  ├─ prisma/schema.prisma
│  │  ├─ migrations/             # includes RLS + FORCE RLS policy migrations
│  │  └─ repositories/           # *Repository interfaces + Postgres impls
│  ├─ retriever/                 # Retriever INTERFACE (pgvector impl now, Qdrant later)
│  ├─ channels/                  # Channel INTERFACE + per-channel adapters
│  │  ├─ whatsapp/               # Cloud API (Tech Provider, Embedded Signup)
│  │  ├─ instagram/  meta-graph shared
│  │  ├─ messenger/
│  │  ├─ web-widget/             # publishable+secret keys, HMAC identity, SSE+REST
│  │  └─ email/                  # Mailgun Routes / SendGrid Inbound Parse
│  ├─ crypto/                    # Supabase Vault (pgsodium) + app-level per-tenant AES-256-GCM (crypto-shred)
│  ├─ model-gateway/             # LiteLLM client + per-tenant virtual-key mgmt
│  ├─ billing/                   # Stripe Billing Meters + internal usage-ledger logic
│  ├─ tenancy/                   # SET LOCAL app.tenant_id helper; tenant-resolve (jwt tenant_id)
│  ├─ observability/             # OTel setup + Langfuse client + audit-log writer
│  └─ queue/                     # pgmq queue/job defs + pg_cron + idempotency (unique wamid + idempotency table)
│
├─ widget/                       # the embeddable web-chat widget (JS loader + iframe)
│  ├─ loader/                    # tiny publishable-key script
│  └─ iframe-app/                # sandboxed chat UI
│
├─ infra/                        # Terraform: compute (Cloud Run/Fly/Railway), Supabase (Postgres/Vault/Queues/Realtime/Storage), IAM, LB/Armor
│  ├─ modules/
│  └─ environments/  (staging | prod)
│
├─ ops/
│  ├─ n8n/                       # internal ingestion/ops flows (SSO+VPC, no public webhook)
│  └─ runbooks/                  # incident, cap-breach, crypto-shred (GDPR) runbooks
│
├─ docs/                         # ← this document lives here (06-roadmap.md)
├─ .github/workflows/            # CI: lint, test, isolation-invariant, deploy
├─ docker-compose.yml            # local plane: Supabase (pg+pgvector+pgmq+pg_cron), litellm, n8n
├─ nx.json  ·  package.json  ·  pnpm-workspace.yaml
└─ README.md
```

**Layout rules that matter:**
- **`libs/contracts`** holds the canonical `Message` type and all DTOs so the edge, worker, ingest, and Flutter app never drift on shape.
- **`libs/retriever`** and **`libs/channels`** are interface-first so a new channel or a Qdrant swap is an adapter, not a refactor.
- **RLS policies are code** in `libs/db/migrations` — reviewed in PRs, never hand-applied to prod.
- **`ops/n8n`** is internal-only: behind SSO + VPC, **no public webhook exposure for tenant data**.

---

## 3. Phased Roadmap

Each phase has a **goal, what you build, exit criteria, and the security gate that must pass before the next phase starts.** The ~15-week MVP estimate covers Phase 0 → Phase 2. P0 security is **not** a phase — it is woven into Phase 0 and is non-negotiable from the first webhook.

```
P0 ──► P1 ──────► P2 ───────────► P3 ──────► P4 ─────────► P5
skeleton  WhatsApp   AI brain +      billing/   more         analytics,
+ auth    end-to-end RAG + biz-form  subs       channels     handoff, scale
[~wk0-4]  [~wk4-8]   [~wk8-15 = MVP] [post-MVP] [gated review][scale-out]
```

### Phase 0 — Skeleton + Auth + Security Foundation  `(~weeks 0–4)`

**Goal:** A deployable, multi-tenant-safe shell with nothing intelligent in it — but the isolation model is real from line one.

**Build:**
- Nx monorepo, `docker-compose` local plane, Terraform for staging (compute on Cloud Run / Fly.io / Railway, Supabase project — Postgres, Vault, Queues/pg_cron, Realtime, Storage —, Secret Manager, IAM).
- **Postgres schema + RLS:** `tenants`, `users`, `channels`, `conversations`, `messages`, `encrypted_tokens`, `usage_ledger`, `audit_log`. **RLS + FORCE ROW LEVEL SECURITY on every tenant table**; app role is **non-owner, non-superuser, no-BYPASSRLS** (**NEVER** Supabase `service_role` for tenant data — it bypasses RLS, the same flaw that disqualified Firebase); **every index led by `tenant_id`**. RLS policies read the tenant from a custom JWT claim (`auth.jwt() ->> 'tenant_id'`).
- **Tenancy plumbing:** `SET LOCAL app.tenant_id` per transaction (never plain `SET` — leaks across pooled connections). Connect via Supabase's pooler (**Supavisor**) in **transaction mode**.
- **Supabase Auth** wired (identity only, JWT); edge verifies token → resolves tenant → server-side authorization.
- **Encryption** (`libs/crypto`): **Supabase Vault (pgsodium AEAD, per-DB root key)** for at-rest, PLUS an **app-level per-tenant AES-256-GCM layer** so deleting the per-tenant app key crypto-shreds that tenant. Store only ciphertext + IV/tag. Crypto-shred path stubbed + runbook.
- **Supabase Queues (pgmq) + pg_cron** declared; a no-op `inbound → outbound` round-trip proves the async hop. (Upstash Redis + BullMQ kept on file if richer queue semantics are needed.)
- Flutter shell: login, empty channel list, empty dashboard.
- **Langfuse + OTel + audit-log writer** wired even before there's AI to trace.

**Exit criteria / security gate (must all be green):**
- [ ] **The invariant test:** a query with no `app.tenant_id` set returns **zero rows** (CI gate).
- [ ] Two test tenants cannot read each other's rows under any code path.
- [ ] A channel token round-trips through encrypt→store→decrypt; only ciphertext is at rest.
- [ ] `audit_log` is hash-chained and append-only; no tokens/PII logged anywhere.
- [ ] Staging deploys from `main` via CI with the isolation test passing.

### Phase 1 — One Channel End-to-End: WhatsApp  `(~weeks 4–8)`

**Goal:** A real business connects its own WhatsApp number and exchanges messages through Assisty — with a **canned/echo reply**, no AI yet. Proves the channel + webhook + queue + isolation spine under live Meta traffic.

**Build:**
- **WhatsApp connector** (`libs/channels/whatsapp`) as a Meta **Tech Provider** (not BSP → zero messaging markup; tenant attaches their own payment method).
- **Embedded Signup** onboarding: `FB.login` with `config_id`, `response_type:'code'`, `solutionID` → returns `code` + `WA_EMBEDDED_SIGNUP` (`waba_id`, `phone_number_id`). Backend exchanges code → **Business Integration System User token** (effectively non-expiring) → store **encrypted, one per tenant**.
- **Two mandatory post-onboarding calls:** `POST /{waba_id}/subscribed_apps` (skipping this = **no inbound webhooks**, the #1 multi-tenant failure since late 2025) and `POST /{phone_number_id}/register` with the 6-digit PIN.
- **Single shared webhook** for all tenants: verify `X-Hub-Signature-256` (HMAC-SHA256 over **raw body**, constant-time compare, 5-min timestamp tolerance), **route by `phone_number_id`/`waba_id` from the payload — never trust a tenant id in the body** — dedupe on `wamid` (Postgres **unique constraint** on `wamid` + an **idempotency table**, not Redis `SETNX`), return 200 in ~50ms, enqueue.
- **24h-window state machine** + outbound send (free-form service inside window; templates outside).
- Echo/canned worker reply to prove the full inbound→queue→worker→outbound loop + live Realtime dashboard (CDC; SSE fallback).

**Exit criteria / gate:**
- [ ] A new tenant self-serves WhatsApp connect end-to-end; `subscribed_apps` + `register` both succeed.
- [ ] Inbound from two tenants' numbers route to the correct tenant; `wamid` redeliveries dedupe.
- [ ] Webhook p95 to-200 stays ~50ms under burst; nothing dropped on a worker-slow scenario.
- [ ] Outbound respects the open-24h-window rules.

### Phase 2 — AI Brain + RAG + Business-Info Form  `(= MVP, ~weeks 8–15)`

**Goal:** Replace the echo with a grounded, tenant-isolated AI agent. **This is the shippable MVP.**

**Build:**
- **LiteLLM Proxy** HA (long-lived service: Cloud Run / Fly.io / Railway); **per-tenant virtual keys** (budget, model restriction, auto-fallback on 429/500/timeout). Tenant picks GPT vs Gemini.
- **Business-info / agent-activation form** (Flutter) → KB files land in **Supabase Storage** → scale-to-zero `ingest` job (pg_cron-triggered): chunk → embed (`text-embedding-3-small`) → **pgvector upsert with `tenant_id` re-stamped server-side**.
- **RAG retrieval** (`libs/retriever`): embed query → pgvector HNSW `WHERE tenant_id = current_setting('app.tenant_id')` (index led by `tenant_id`; RLS is the backstop) → top-k grounding.
- **AI turn:** load tenant config + conversation memory (keyed `(tenant_id, conversation_id)` in Postgres under RLS + in-process hot cache) → **pre-flight cap check against `usage_ledger`** (short-circuit to a templated "limit reached" path before any model call) → single LiteLLM chat call for simple Q&A.
- **Tool-calling discipline:** every tool/function call has **`tenant_id` injected server-side** from the resolved session — the model is never asked to supply it (top cross-tenant leak vector).
- **Usage ledger** writes (tokens + messages) in the **same RLS transaction** as the reply; Langfuse traces every turn (prompt + chunks + cost per tenant).

> LangGraph (cyclic commerce reasoning) and the visual flow builder are **deferred** — simple Q&A stays a single linear call for latency. Graft them in Phase 4+ when commerce intents demand it.

**Exit criteria / gate:**
- [ ] Agent answers from a tenant's KB only; a cross-tenant retrieval is provably impossible (invariant test extended to vector path).
- [ ] Pre-flight cap check blocks spend before the LLM call when a tenant is over cap.
- [ ] Tier change triggers a per-tenant re-embed via the ingest job (embedding model pinned per tier).
- [ ] Turn p95 stays well under n8n's reported 16s; warm workers keep queue depth low.
- [ ] LLM fallback fires on a simulated 429 without dropping the turn.

### Phase 3 — Billing / Subscriptions  `(post-MVP)`

**Goal:** Charge businesses directly, with transparent, spend-capped pricing and **no Google Play fee**.

**Build:**
- **Stripe Billing + Billing Meters API** (legacy usage-records API is deprecated) reporting two meters: `messages_sent`, `ai_tokens`.
- **Internal `usage_ledger` = source of truth** for hard-cap enforcement (checked pre-flight in the worker). Stripe meters are **invoicing only** — a Stripe lag can never cause overspend.
- **Web-only checkout**, linked (never embedded) from the Android binary → preserves Google Play's **cloud-business-software + consumed-outside-the-app** exemptions. **Verify classification in Play Console pre-launch.**
- Plans gate: model choice (GPT vs Gemini), embedding tier, channel count, message/token caps.
- **Pricing transparency copy:** surface that real WhatsApp cost can be **2–5× sticker** (hidden Meta per-message fees) and that **Utility messages inside the open 24h window are free**. WhatsApp bills to the tenant's own payment method → **zero markup; we bill software only.** No markup on pass-through LLM costs (avoid the thin-wrapper trap); AI bundled into base (no ManyChat-style $29 add-on).
- **Ledger write-hotspot mitigation (grafted from C1):** pre-plan ledger-increment batching / partitioned counters so a viral tenant's per-message increments + audit appends don't bottleneck the worker transaction.

**Exit criteria / gate:**
- [ ] Hard cap enforced from the ledger before spend; Stripe invoice matches ledger within tolerance.
- [ ] Play Console classification confirmed; Android binary contains zero purchase flow.
- [ ] Pricing page shows transparent WhatsApp pass-through + spend caps.

### Phase 4 — More Channels  `(gated by Meta review timelines)`

**Goal:** Reach channel table-stakes: WhatsApp + Instagram + Messenger + web widget + email.

**Build:**
- **Web widget + Email first** (fully under our control, no external gate): widget = JS loader → sandboxed iframe, publishable key client-side + secret key server-side, Realtime+REST (SSE fallback), **HMAC identity verification** (Chatwoot is the reference). Email via Mailgun Routes / SendGrid Inbound Parse, thread by `Message-ID`/`References`, set **SPF/DKIM/DMARC**.
- **Instagram DM + Messenger** (shared Graph API, same 24h window + webhook/Send model) — **gated by Meta App Review + Business Verification (weeks-to-months).** Start this clock early. Past 24h, the human-agent tag is **humans only** (no bot automation); legacy message tags die **Apr 27, 2026**.
- **LangGraph commerce path** + optional visual flow builder graft in here (hybrid surface: LLM-native default + deterministic flows for commerce guardrails).
- **n8n outbound integrations** exposed to tenants (Sheets/CRM/Slack) — **Core API re-validates and re-stamps `tenant_id` on every n8n-originated write.**

**Exit criteria / gate:**
- [ ] Each new channel routes through the same `Channel` interface; worker stays channel-agnostic.
- [ ] Widget HMAC identity verified server-side; no anonymous impersonation.
- [ ] Meta App Review + Business Verification passed before IG/Messenger go live.

### Phase 5 — Analytics, Human Handoff, Scale  `(scale-out)`

**Goal:** Operate at hundreds of tenants with insight, escalation, and headroom.

**Build:**
- **Analytics dashboards:** resolution rate, deflection, per-tenant spend, channel mix — fed by the ledger + Langfuse.
- **Human handoff:** agent take-over; if it spans hours, this is the trigger to introduce **Temporal** (deferred until now by design).
- **Scale moves behind existing interfaces:** Supabase Postgres read replicas / partitioning via the repository layer; **pgvector → Qdrant** via the `Retriever` interface when vector volume or p99 demands it (re-embed is real but blast-radius-bounded).
- **Hardening to plan:** finalize DPA + sub-processor list (Supabase, OpenAI, Google, Anthropic, Stripe, Meta, Mailgun); full token-bucket rate limiting (tenant + user + endpoint); documented **GDPR 1-month crypto-shred erasure** path (delete the per-tenant app key) tested end-to-end.

**Exit criteria / gate:**
- [ ] Qdrant swap (if triggered) ships behind `Retriever` with no caller changes.
- [ ] Crypto-shred erases a tenant within the documented GDPR window, verified unrecoverable.
- [ ] Rate limits + Cloud Armor hold under a load/abuse test.

---

## 4. Cross-Phase Invariants (true from Phase 0 onward)

These never regress. Treat any violation as a release blocker.

1. **RLS + FORCE RLS** on every tenant table; app role non-owner/non-superuser/no-BYPASSRLS — **NEVER** Supabase `service_role` for tenant data (it bypasses RLS, the same flaw that disqualified Firebase); **`SET LOCAL app.tenant_id` per transaction** (never plain `SET`); connect via the **Supavisor** pooler in transaction mode.
2. **Every index led by `tenant_id`**; the no-`tenant_id` query returns zero rows (CI invariant test) — relational **and** vector.
3. **`tenant_id` injected server-side** into every tool call and **re-stamped on every async/ingestion-originated write** (defense-in-depth on top of RLS).
4. **Encryption** for all third-party channel tokens: **Supabase Vault (pgsodium AEAD)** at-rest PLUS an **app-level per-tenant AES-256-GCM layer**; only ciphertext stored; crypto-shred ready (delete the per-tenant app key).
5. **Webhooks:** HMAC-SHA256 over raw body, constant-time compare, 5-min tolerance, dedupe by event id; return 200 fast, process async.
6. **Caps enforced before spend** from the internal ledger — never after Stripe.
7. **No purchase flows in the Android binary** (Google Play exemption).
8. **n8n is never the live turn.**
9. **Tamper-evident `audit_log`**; never log tokens or PII.

---

## 5. Billing Posture & Google Play (why this is the strategic win)

```
              ┌──────────────────────────────────────────────┐
   Business ──┤  Stripe Billing (direct, web checkout)        │  ← NO Google fee
   pays  ─────┤  meters: messages_sent · ai_tokens (invoicing)│     (Play exemption:
              └───────────────▲──────────────────────────────┘      cloud-business-sw +
                              │ usage reported async                  consumed-outside-app)
              ┌───────────────┴──────────────────────────────┐
   Worker ────┤  internal usage_ledger = SOURCE OF TRUTH      │  ← hard caps enforced
   writes ────┤  pre-flight cap check BEFORE any LLM call     │     pre-flight (no runaway bill)
              └──────────────────────────────────────────────┘

   WhatsApp per-message Meta fees ──► billed to TENANT's own payment method
                                      (we are a Tech Provider, not a BSP)  = $0 to Assisty
```

- **Stripe Billing directly** (not RevenueCat — that's for consumer IAP). **Billing Meters API** (legacy usage records deprecated).
- **Internal ledger is the cap authority**; Stripe is invoicing only ⇒ a Stripe lag can never cause overspend.
- **Differentiate on transparency + spend caps**; bundle AI into base; do **not** mark up pass-through LLM/WhatsApp costs.

---

## 6. Rough Cost Model

> **All figures are Assisty's *infrastructure* floor. Pass-through LLM + WhatsApp costs are funded by tenants** (LLM recovered in plan pricing at no markup; WhatsApp billed by Meta to each tenant's own payment method = **$0 to Assisty**). Stripe fees are a % of revenue, not infra.

### 6.1 MVP / ~50 tenants (moderate volume)

| Line item | Monthly | Notes |
|---|---|---|
| Supabase Postgres HA (Pro/compute add-on + storage/backups) | $250–350 | single system of record + vectors; pgvector + pgmq/pg_cron + Vault + Realtime + Storage built-in |
| Compute: edge + worker + LiteLLM (3 svc on Cloud Run / Fly.io / Railway, warm `min=1`, modest CPU) | $200–350 | ingest/meter jobs scale-to-zero (not in floor) |
| Secret Manager | $10–30 | platform secrets (per-tenant key material lives in Vault/Postgres) |
| Networking / LB / Cloud Armor | $50–100 | WAF + egress |
| Logging / Trace / Monitoring (+ Langfuse) | $50–150 | OTel + per-turn LLM tracing |
| **Assisty infra subtotal** | **~$700–1,200/mo** | the always-on floor (no separate managed Redis line) |
| *Pass-through LLM (recovered, NOT marked up)* | *$300–800* | embeddings $0.02/1M + GPT/Gemini chat |
| *WhatsApp Meta per-message fees* | *$0 to Assisty* | billed to tenant's own payment method |

**Floor-compression lever (grafted from C1):** keep `min-instances=1` strictly on **edge + AI worker**; let ingest/embedding/billing-meter jobs (and LiteLLM where a cold-start fallback exists) scale toward zero. At single-digit tenant counts this pulls the floor toward the **~$700** end.

### 6.2 Scaling to ~500 tenants (order-of-magnitude estimate)

> Roughly **5–8× the MVP floor**, not 10× — fixed HA overhead amortizes; compute and DB scale with load, not headcount.

| Line item | Monthly (est.) | Driver |
|---|---|---|
| Supabase Postgres HA (larger compute + read replica + more storage/IOPS) | $1,200–2,200 | metering writes + vector volume + pgmq throughput; replica for read-heavy dashboards |
| Compute: edge + worker (autoscaled) + LiteLLM HA (Cloud Run / Fly.io / Railway) | $1,200–2,500 | concurrency 80 × more instances; warm floor higher |
| Secret Manager | $50–150 | platform secrets + crypto ops |
| Networking / LB / Cloud Armor | $200–500 | higher egress + request volume |
| Logging / Trace / Monitoring + Langfuse | $300–800 | per-turn trace volume scales with traffic |
| **Assisty infra subtotal** | **~$3,000–6,200/mo** | ~5–8× MVP |
| *Pass-through LLM (recovered)* | *scales with traffic* | embeddings + chat; no markup |
| *WhatsApp Meta fees* | *$0 to Assisty* | tenant-funded |

**Cost watch-points at 500:**
- **pgvector p99** at high QPS / large vector counts is the first thing to bend → the gated **Qdrant** swap (behind `Retriever`) is the relief valve.
- **Usage-ledger write hotspot** from viral tenants → ledger-increment batching / partitioned counters (pre-planned in Phase 3).
- **LiteLLM HA** must stay `min-instances ≥ 1` with health checks — it's on the egress path for every AI turn; do not let it become a single point of failure.

---

## 7. Decision Log (what we deliberately did NOT do, and why)

| Rejected | Chose instead | Reason |
|---|---|---|
| n8n as the runtime brain | Custom NestJS turn-service | 16s+ prod times, 2–4 LLM calls/query, no per-tenant memory isolation, fixed concurrency. |
| Firestore as system of record | Supabase Postgres + pgvector | Relational + metering-heavy domain; Firestore per-op pricing unpredictable at messaging scale; one RLS model. (Firestore also bypasses RLS-style row isolation — same `service_role`-style flaw Supabase avoids by using a tenant-scoped non-superuser role.) |
| Managed Redis + BullMQ at MVP | Supabase Queues (pgmq) + pg_cron | One stateful store; durable in-Postgres queues + scheduled jobs, no separate Redis line. **Upstash Redis + BullMQ kept on file** for richer queue semantics. |
| Separate vector DB at MVP | pgvector in the same Postgres | Collapse to one stateful store, one isolation + backup story; Qdrant is a gated swap. |
| Self-hosted Llama-405B cascade | LiteLLM over hosted providers | Same "custom routing layer" goal, far less ops cost; not justified at MVP/50-tenant scale. |
| Supabase Edge Functions for the edge/worker | Long-lived Node on Cloud Run / Fly.io / Railway | Edge Functions are Deno, 150s-capped, light async/ingest only; the synchronous edge + AI worker need a long-lived process. |
| WebSockets (custom) for live dashboard | Supabase Realtime (Postgres CDC); SSE fallback | Realtime ships CDC over WebSocket out of the box; SSE survives behind the LB as the fallback if a long-lived edge stream is preferred. |
| RevenueCat / Play IAP | Stripe Billing direct (web checkout) | Google Play cloud-business-software exemption ⇒ no service fee; ledger-gated caps. |
| Meta BSP | Meta **Tech Provider** | Tenant attaches own payment method ⇒ zero messaging markup; we bill software only. |
| Temporal / Kubernetes at MVP | Supabase Queues (pgmq) + long-lived compute (Cloud Run / Fly.io / Railway) | Deferred until a real hours-long handoff use case (Phase 5) forces it; keep it solo-team operable. |
| TikTok DM automation | Out of scope | No open API; partner-gated AND geo-blocked for US/EEA/UK/CH; do not promise it. |
