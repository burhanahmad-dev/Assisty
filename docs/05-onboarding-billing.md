# Auth, Onboarding Flow & Subscriptions

> **Scope.** This document specifies three tightly coupled systems for Assisty: (1) **authentication** for operators of tenant businesses, (2) the **onboarding journey** that takes a freshly-signed-up business from "empty account" to a **live customer-service agent**, and (3) **billing & subscriptions** — the B2B plan/quota model, the metering pipeline, and the payments-platform decision.
>
> It is written to be built against the **winning architecture**: NestJS (Fastify) on Cloud Run / Fly.io / Railway as a stateless edge + a Supabase Queues (pgmq) + pg_cron-driven NestJS worker fleet, Supabase Postgres 16 + pgvector as the single system of record (RLS + `FORCE ROW LEVEL SECURITY`, `SET LOCAL app.tenant_id` per transaction), LiteLLM Proxy as the model gateway, Supabase Vault (pgsodium AEAD) plus an app-level per-tenant AES-256-GCM crypto-shred layer, and **Stripe Billing (Meters API)** with an internal Postgres usage ledger as the source of truth. Supabase Auth is **identity-only**. Nothing here contradicts that design; where this doc adds a decision, it is called out as such. (Backend platform decision: see **ADR-0002** — `docs/ADR-0002-supabase-backend.md`.)
>
> **Load-bearing warning.** Supabase `service_role` bypasses RLS (the same flaw that disqualified Firebase) — the edge and AI worker **MUST** use a dedicated tenant-scoped non-superuser role with RLS enforced and `SET LOCAL app.tenant_id` per transaction, **NEVER** `service_role` for tenant data. Use Supabase's pooler (Supavisor) in transaction mode.

---

## 0. The journey at a glance

```
                         THE ASSISTY ACTIVATION FUNNEL
                         (operator = the human running a tenant business)

  ┌──────────┐   ┌──────────┐   ┌───────────┐   ┌────────────┐   ┌─────────────────┐
  │ 1. SIGN  │──▶│ 2. SUB-  │──▶│ 3. CONNECT│──▶│ 4. ACTIVATE│──▶│ 5. BUSINESS-INFO│
  │    UP    │   │  SCRIBE  │   │  CHANNEL  │   │   AGENT    │   │      FORM       │
  │ (Auth)   │   │ (Stripe) │   │ (WA/IG/…) │   │  (button)  │   │ products/FAQ/…  │
  └──────────┘   └──────────┘   └───────────┘   └────────────┘   └────────┬────────┘
                                                                          │
                      ┌───────────────────────────────────────────────────┘
                      ▼
  ┌─────────────────────┐   ┌──────────────────────┐   ┌───────────────────────────┐
  │ 6. INGESTION → RAG  │──▶│ 7. SMOKE TEST        │──▶│ 8. AGENT GOES LIVE        │
  │ chunk→embed→pgvector│   │ tenant chats its own │   │ webhook flips to active;  │
  │ (pgmq ingest job)   │   │ agent in-dashboard   │   │ real customers handled    │
  └─────────────────────┘   └──────────────────────┘   └───────────────────────────┘
```

**Why subscribe *before* connect (step 2 before 3).** WhatsApp Embedded Signup mints an effectively-non-expiring Business Integration System User token that we must store, encrypt, and (per Meta Tech Provider rules) attach to a billable relationship. Gating channel connection behind an active subscription means we never hold long-lived third-party credentials for a non-paying account, and the `phone_number_id → tenant` routing table only ever contains paying tenants. It also makes the funnel honest: the operator commits before they invest 15 minutes filling the business-info form. (Trial handling — see §7.1 — uses a real Stripe subscription in `trialing` status, not a separate code path.)

---

## 1. Authentication

### 1.1 Who authenticates, and who does not

Assisty has **two completely separate identity surfaces**. Conflating them is the most common multi-tenant auth mistake.

| Principal | Who | How they authenticate | Notes |
|---|---|---|---|
| **Operator** | The human(s) running a tenant business (owner, support lead) | **Supabase Auth** (email/password, Google, Apple) → JWT → verified server-side | This document's subject. Maps to `users` rows, scoped to one `tenant_id` (or several, see §1.6). RLS policies read the tenant from a custom JWT claim (`auth.jwt() ->> 'tenant_id'`). |
| **End customer** | The shopper messaging the business on WhatsApp/IG/web | **Never authenticates to Assisty.** Identity is the channel-native handle (`phone_number_id` + WA user id, IG-scoped id, web HMAC-verified visitor id). | They are *data*, not *principals*. No Assisty login. |
| **Channel platform** | Meta, Mailgun, Stripe calling our webhooks | **HMAC signature** over the raw body (not a session) | See §1.5. |
| **Internal services** | edge ↔ worker ↔ LiteLLM | **Dedicated tenant-scoped non-superuser Postgres role** (RLS enforced, `SET LOCAL app.tenant_id`; **never** `service_role`) + LiteLLM virtual keys | Least-privilege; no human auth. Connect via Supabase pooler (Supavisor) in transaction mode. |

> **Decision: Supabase Auth as identity-only, authorization in Postgres.** Supabase Auth gives us battle-tested email/Google/Apple sign-in, password reset, email verification, and (paired with FCM) push-token plumbing with near-zero glue — exactly the dev-speed claw-back the brief wants. But **we never trust a client-side claim alone for authorization.** Crucially, Supabase `service_role` bypasses RLS (the same flaw that disqualified Firebase), and a JWT claim is only as fresh as the last token refresh. Every request re-derives the operator's tenant scope server-side from our own `users` table and sets `SET LOCAL app.tenant_id` for the transaction — using a dedicated tenant-scoped non-superuser role, **never** `service_role` — while RLS policies independently read the tenant from the custom JWT claim (`auth.jwt() ->> 'tenant_id'`). Supabase Auth answers *"who is this human?"*; Postgres RLS answers *"what may they touch?"*

### 1.2 Signup & login flow

```
 FLUTTER (Riverpod 2 + GoRouter)            NESTJS EDGE (Cloud Run/Fly/Railway)  POSTGRES (Supabase)
 ───────────────────────────────            ───────────────────────────────────  ───────────────────
  signInWithGoogle()/createUser()
        │  Supabase access token (JWT)
        ▼
  Dio → POST /v1/auth/session  ───────────▶  verify Supabase JWT
        Authorization: Bearer <jwt>          │  (verify sig, aud, exp, revoked?)
                                             ▼
                                       upsert user by supabase_uid ─────▶ INSERT/SELECT users
                                             │                              (supabase_uid UNIQUE)
                                             │  first login? → create tenant
                                             ▼                              INSERT tenants (status=
                                       resolve memberships ────────────────  'provisioning')
                                             │
                                             ▼
                                       mint Assisty session JWT
                                       { sub:user_id, tenants:[…],
                                         active_tenant, role, ver }
        ◀──────────────────────────── 200 { session, tenants, onboarding_state }
  store session (flutter_secure_storage)
  GoRouter redirect → onboarding or dashboard
```

**Concrete choices:**

- **Library:** `supabase_flutter` + `google_sign_in` + `sign_in_with_apple` (Apple is mandatory for App Store if you offer Google; harmless on Android). Backend: verify the Supabase JWT server-side (check sig, aud, exp, revoked).
- **Providers at launch:** Email/Password, Google, Apple. **Defer** Microsoft/SAML SSO to an Enterprise plan add-on (§4) — it is a sales-gated feature, not an MVP one.
- **Our own session.** After verifying the Supabase JWT *once* per session, we mint a short-lived **Assisty JWT** (15 min access, signed with a key in Secret Manager) + a rotating refresh token stored server-side (`sessions` table, hashed). Rationale: a 1-hour Supabase token can't carry our `active_tenant`/`role`/token-version, and we need **server-side revocation** (kick a fired employee instantly) which Supabase token revocation alone is too coarse for. The `ver` claim is checked against `users.token_version`; bump it to invalidate every session for a user.
- **Email verification is a gate.** `supabase_user.email_confirmed_at == null` ⇒ operator may view the dashboard shell but **cannot connect a channel or activate an agent** (prevents throwaway-email abuse of the WhatsApp onboarding path).

### 1.3 Session storage on device

| Item | Storage | Reason |
|---|---|---|
| Supabase refresh token | `supabase_flutter` internal (Keychain/Keystore) | Managed by SDK |
| Assisty access JWT (15m) | In-memory (Riverpod provider) | Not persisted; cheap to re-mint |
| Assisty refresh token | `flutter_secure_storage` (Keychain/EncryptedSharedPreferences) | Survives restart; OS-encrypted |
| `active_tenant` selection | Drift (local cache) | UX continuity |

Dio interceptor: on `401 token_expired` → silently call `/v1/auth/refresh` → retry once → on failure, route to login. **Never** loop refresh.

### 1.4 Roles (intentionally minimal for MVP)

```
OWNER   → billing, channel connect/disconnect, agent activate, invite users, everything
ADMIN   → everything except billing + delete-tenant
AGENT   → view conversations, take over (human handoff), edit business-info form
VIEWER  → read-only dashboards/usage (e.g. an accountant)
```

Stored as `memberships(user_id, tenant_id, role)`. Authorization is a NestJS `@Roles()` guard **plus** RLS — the guard gives a clean 403 with a good error; RLS is the backstop that makes a bug structurally unable to leak across tenants.

### 1.5 Webhook "auth" is signature verification, not sessions

The single shared inbound webhook (`/webhooks/whatsapp`, `/webhooks/meta`, `/webhooks/email`, `/webhooks/stripe`) is the highest-value attack surface. It is not authenticated by a session; it is authenticated by **HMAC over the raw request body**:

- Read the **raw** body (Fastify `rawBody`) — re-serializing JSON breaks the signature.
- `crypto.timingSafeEqual` against `X-Hub-Signature-256` (Meta) / `Stripe-Signature`.
- 5-minute timestamp tolerance (replay window).
- Dedupe by event id (`wamid` for WA, `event.id` for Stripe) via a Postgres **unique constraint** (e.g. unique `wamid`) backed by an idempotency table — the insert fails on a duplicate, so the second delivery is a no-op.
- **Return 200 within ~50 ms, then enqueue.** No LLM work, no DB write beyond the dedupe key, on the webhook thread.
- **Resolve tenant from the payload** (`phone_number_id`/`waba_id`), **never** from a body-supplied tenant id.

### 1.6 Multi-tenant membership (one human, several businesses)

Agencies and multi-brand operators are real. A `user` may belong to N `tenants` via `memberships`. The Assisty session carries the full list; `active_tenant` is switchable in the app (a header `X-Assisty-Tenant: <id>` on each request, validated against memberships server-side before `SET LOCAL`). This costs us almost nothing now and avoids a painful retrofit.

---

## 2. The onboarding journey (step by step)

The operator's state machine. `tenants.onboarding_state` drives both the GoRouter redirect logic in the app and the server-side gates.

```
 signed_up ──▶ subscribed ──▶ channel_connected ──▶ form_submitted ──▶ ingesting ──▶ live
     │             │                 │                     │              │           │
   (1.2)       (Stripe §2.1)     (WA/IG/web §2.2)      (form §2.3)    (RAG §2.4)   (§2.5)
     │             ▲                                                                  │
     └─ no channel ┘                                          re-edit form ──────────┘
        until paid                                            (re-ingest, agent stays live)
```

### 2.1 Step — Subscribe (gate the rest)

The operator picks a plan (§4) and is sent to **Stripe-hosted Checkout on the web** (see §5.2 for *why web*). On `checkout.session.completed` (webhook), we:

1. Create/attach `stripe_customer_id`, `stripe_subscription_id` on the tenant.
2. Set `tenants.plan`, write the plan's caps into `tenant_limits`.
3. Advance `onboarding_state → subscribed`.
4. Provision the tenant's **LiteLLM virtual key** (budget + allowed-models per plan, see §4.3).

Until `onboarding_state >= subscribed`, the "Connect channel" endpoints return `402 Payment Required`.

### 2.2 Step — Connect channel(s)

This is the heaviest external-integration step. Each connector lives behind the internal `Channel` interface; the operator may connect more than one.

#### 2.2.1 WhatsApp (the flagship path) — Embedded Signup

```
 FLUTTER (webview/Custom Tab)            META                       NESTJS EDGE                 VAULT / POSTGRES
 ───────────────────────────            ────                       ───────────                 ────────────────
  FB.login({ config_id,
    response_type:'code',
    extras:{ solutionID }})
        │ user grants WABA access
        ▼
   returns code + WA_EMBEDDED_SIGNUP
   { waba_id, phone_number_id }
        │
        ▼  POST /v1/channels/whatsapp/connect { code, waba_id, phone_number_id }
        └────────────────────────────────────────▶ exchange code → Business Integration
                                                    System User token (≈ non-expiring)
                                                            │
                                                    ┌───────┴────────────────────────────┐
                                                    │ MANDATORY POST-ONBOARDING CALLS:    │
                                                    │ 1. POST /{waba_id}/subscribed_apps  │  ← skip = NO inbound
                                                    │    (no longer auto-created)         │    webhooks (#1 bug)
                                                    │ 2. POST /{phone_number_id}/register │
                                                    │    { pin: 6-digit }                 │
                                                    └───────┬────────────────────────────┘
                                                            ▼
                                                    encrypt token (Supabase Vault
                                                    pgsodium AEAD + app-level
                                                    per-tenant AES-256-GCM) ────────────▶ INSERT channels
                                                            │                              (encrypted token,
                                                            ▼                               phone_number_id→tenant)
                                                    register phone_number_id in
                                                    the shared routing map (Postgres)
```

**Non-negotiables (these are the failures that silently break multi-tenant WhatsApp):**

- We are a **Meta Tech Provider, not a BSP.** Each tenant attaches *their own* Meta payment method ⇒ Meta bills them per-message directly, **zero messaging markup**, we bill software only.
- The **two mandatory post-onboarding calls** (`subscribed_apps` + `register`) are *not optional and not auto-created* since late 2025. Make them a transactional unit: if either fails, the channel row is marked `error` and the operator sees a precise remediation message — never a silent half-connected state.
- The Business Integration System User token is **effectively non-expiring** and is the crown jewel: it sits under Supabase Vault (pgsodium AEAD, per-DB root key) **plus** an app-level **per-tenant AES-256-GCM** layer, so destroying that tenant's app key crypto-shreds it (GDPR erasure).
- **One shared webhook URL** for all tenants; route by `phone_number_id`/`waba_id`. The routing map is the *only* thing the inbound path trusts.

> **Pricing transparency (must surface in the connect UI).** WhatsApp moved to **per-message pricing (since Jul 1, 2025)**: Service messages (free-form, inside the open 24-hour window) are **free**; **Utility templates are free inside the open 24h window**; Marketing/Auth are always paid. Real cost can be **2–5× the sticker** once hidden Meta per-message fees stack. Because we take zero markup, the copy is simply honest: *"WhatsApp message fees are billed by Meta to your own payment method. Assisty adds no markup."*

#### 2.2.2 Instagram DM + Messenger

Shared Graph API, same 24h window + webhook/Send model as WhatsApp, so the connector reuses ~80% of the WA code. **But** they are gated by **Meta App Review + Business Verification (weeks-to-months)** — a launch-timeline risk *outside our control*. Treat as **fast-follow, not MVP-blocking**. Note the platform rule: past 24h the human-agent tag is **humans only — no bot automation** (and legacy message tags die **Apr 27, 2026**), so outside the window the agent must defer to a human handoff, not auto-reply.

#### 2.2.3 Web widget + Email (fully under our control — carry the MVP)

- **Web widget:** JS loader → sandboxed iframe. **Publishable key** client-side, **secret key** server-side, **HMAC identity verification** for logged-in visitors (Chatwoot is the reference). Live updates via **Supabase Realtime (Postgres CDC over WebSocket)**, with SSE + REST as the fallback. We issue both keys at connect time; no external review.
- **Email:** inbound via **Mailgun Routes** or **SendGrid Inbound Parse** → our `/webhooks/email`. Thread by `Message-ID`/`References`. Set **SPF/DKIM/DMARC** for the tenant's sending domain (guided setup in the dashboard).

#### 2.2.4 TikTok — out of scope

No open API, partner-gated, in Beta, and **geo-blocked for US/EEA/UK/CH** businesses. **Do not promise TikTok DM automation.** The UI shows it as "Request access" (waitlist), never as a connectable channel.

### 2.3 Step — Activate agent → the **Business-Info Form**

"Activate" is a single primary button on the dashboard once at least one channel is connected. It opens the **Business-Info Form** — the single most important data the agent will ever have, because it *is* the knowledge base before any document upload. Keep it short enough to finish in one sitting, structured enough to chunk cleanly.

**Exact fields (MVP form schema):**

| # | Field | Type | Required | Goes into RAG as | Notes / validation |
|---|---|---|---|---|---|
| 1 | **Products / Services** | Repeatable rows: `name`, `description`, `price` (optional), `url` (optional) | ✅ ≥1 | One chunk per product (named, price-tagged) | The catalog. Also seeds commerce tool-calling later. CSV/Shopify import is a fast-follow. |
| 2 | **FAQs** | Repeatable Q/A pairs | ✅ ≥3 | One chunk per Q/A (Q in the embedded text + metadata) | The single highest-signal source for deflection. Suggest starters ("Do you offer refunds?", "What are shipping times?"). |
| 3 | **Policies** | Long text per policy: Returns, Shipping, Privacy, Warranty (each optional but Returns strongly nudged) | ⚠️ ≥1 nudged | Section-split chunks (~400–800 tokens, 15% overlap) | Free-text or paste from existing policy pages. |
| 4 | **Business hours** | Structured: per-day open/close + timezone, or "24/7" | ✅ | Single chunk + **structured metadata** (used for "are you open?" without an LLM call) | Timezone is mandatory — drives 24h-window UX too. |
| 5 | **Tone / persona** | Enum (`friendly`, `professional`, `playful`, `concise`) + optional free-text "voice notes" + "things never to say" | ✅ | **Not embedded** — injected into the system prompt | Stored on `tenant_config`, not the vector store. The "never say" list is a guardrail, surfaced verbatim in the system prompt. |

Plus an **optional document upload** at the end (PDF/DOCX/TXT/URL crawl) for tenants who already have a help center — files land in **Supabase Storage** and run the same ingestion pipeline, just more chunks.

```
 BUSINESS-INFO FORM  →  CANONICAL KB DOCUMENTS  →  INGESTION
 ───────────────────    ──────────────────────    ──────────
  products[]  ─────────▶ doc(type=product)   ─┐
  faqs[]      ─────────▶ doc(type=faq)        ─┤
  policies[]  ─────────▶ doc(type=policy)     ─┼──▶ enqueue ingest job (pgmq)
  hours       ─────────▶ doc(type=hours) +     │
                          structured metadata  │
  tone/persona ───────▶ tenant_config (NOT a doc; system-prompt only)
  uploads[]   ─────────▶ doc(type=upload)     ─┘
```

On submit: persist to `tenant_config` + `kb_documents` (RLS-scoped), advance `onboarding_state → form_submitted`, and enqueue one **ingest job** carrying `tenant_id` + the changed document ids.

### 2.4 Step — Ingestion into RAG

The ingest pipeline runs **off the live turn**, on a stateless NestJS worker (Cloud Run / Fly.io / Railway) pulling the **Supabase Queues (pgmq)** `embeddings/ingest` queue, driven by **pg_cron**. (Light async/ingest tasks could also run on Supabase Edge Functions — Deno, 150s-capped — but the long-lived worker is the default.)

```
 INGEST JOB (NestJS worker, RLS txn: SET LOCAL app.tenant_id)
 ─────────────────────────────────────────────────────────────
   load changed kb_documents (tenant-scoped)
        │
        ▼
   chunk  ──▶ ~400–800 tokens, 10–15% overlap, never split a Q/A pair;
        │      product = atomic chunk; policy = section-split
        ▼
   embed  ──▶ LiteLLM /embeddings with the tenant's virtual key
        │      • Default: text-embedding-3-small  (1536d, $0.02/1M)
        │      • Quality tier: gemini-embedding-001 (truncate→1536, Matryoshka)
        │      ⚠ embedding model is IMMUTABLE per index — pinned by plan tier
        ▼
   upsert ──▶ pgvector (HNSW), row carries tenant_id (RLS + tenant-led index)
        │      RE-STAMP tenant_id server-side on write (don't trust the job payload)
        ▼
   advance onboarding_state → live; emit "ingestion_complete" via Supabase Realtime (CDC)
```

**Decisions baked in here:**

- **Re-stamp tenant_id on every write.** The ingest worker is a *less-trusted async plane* than the edge. Even though the job payload carries `tenant_id` and RLS backstops it, the worker opens its transaction with `SET LOCAL app.tenant_id` from the **job's authenticated tenant binding** and re-stamps it onto every upserted row. This is the C3 hardening rule applied to all async writers — defense in depth, not RLS trust.
- **Structural isolation invariant (enforced, not assumed).** Add an automated test asserting that a pgvector similarity query executed **without** `app.tenant_id` set returns **zero rows**. Treat the `tenant_id` payload filter + tenant-led HNSW index as a *hard partition*, paired with RLS — "structurally impossible to leak" plus "policy-enforced," which is stronger than either alone. Consider per-tenant table partitioning of the vector table as the second structural barrier.
- **Embedding model is immutable per index.** Switching a tenant's embedding model (e.g., a tier upgrade) forces a **full per-tenant re-embed** — handled as a dedicated re-embed job, model pinned by plan tier (§4.2). Never silently mix embedding spaces in one index.
- **n8n is *allowed* here, but not the default.** Default ingestion = the NestJS worker driven by Supabase Queues (pgmq) + pg_cron. Introduce n8n as the ingestion/re-embedding plane *only if* a real tenant demand for no-redeploy ingestion iteration materializes — and if so, behind SSO + VPC with no public webhook exposure, and with the same `tenant_id` re-stamp rule. Avoid the premature dual-ops tax.
- **Retriever interface = the escape hatch.** All retrieval goes through a `Retriever` port; pgvector is one adapter. When vector volume or p99 latency demands it, **Qdrant** (indexed `tenant_id` payload filter inside HNSW) slots behind the same interface with bounded blast radius. Same discipline applies to a repository/data-access layer over Supabase Postgres for future read-replica/sharding moves.

### 2.5 Step — Smoke test → agent goes live

Before flipping live, the operator chats their *own* agent inside the dashboard (a synthetic web-widget conversation, no channel cost). This catches an empty/garbled KB before a real customer does. On confirm — or automatically once `ingestion_complete` fires for a non-fussy tenant — `onboarding_state → live` and the inbound webhook path begins routing real customer messages for that `phone_number_id`/channel to the AI worker.

**Add Langfuse here.** Per-turn LLM tracing (prompt, retrieved chunks, token/cost per tenant) alongside Cloud Trace/OTel is materially more useful for debugging RAG quality, attributing spend to the usage ledger, and detecting jailbreak/prompt-injection attempts than generic traces. Wire it into the worker from day one.

---

## 3. End-to-end live turn (for context — where billing meters fire)

```
 customer msg ─▶ shared webhook (verify HMAC, 200 in ~50ms, dedupe wamid via unique constraint) ─▶ pgmq inbound
                                                                                   │
   ┌───────────────────────────────────────────────────────────────────────────────┘
   ▼  AI WORKER (RLS txn: SET LOCAL app.tenant_id)
   ① PRE-FLIGHT CAP CHECK ── read internal usage_ledger; over hard cap?
   │        └─ YES → templated "limit reached" reply; NO model call.  ← spend gated BEFORE Stripe
   ② RAG  ── embed query (LiteLLM tenant key) → pgvector top-k WHERE tenant_id=current_setting(...)
   ③ TURN ── one LiteLLM chat call (tenant's model: GPT or Gemini) [+ LangGraph only for
   │          cyclic commerce tool-use; tenant_id INJECTED server-side into every tool call]
   ④ WRITE── reply row + usage_ledger increment, same RLS txn
   ⑤ OUT  ── enqueue outbound-send (respect 24h window) ; enqueue billing-meter job
                                                              │
                                                              ▼
                              report messages_sent / ai_tokens → Stripe Billing Meters API (async)
```

The two meters fire in step ⑤; the **hard cap** is enforced in step ① from the internal ledger — never from Stripe.

---

## 4. B2B plan, quota & metering design

### 4.1 What we meter — and the two-tier guardrail

Two competitor failure modes shape this: **Intercom Fin's per-resolution, no-cap model** (runaway-bill risk) and **ManyChat's $29 AI add-on** (nickel-and-diming). Assisty's answer: **bundle AI in the base, meter transparently, and hard-cap by default.**

```
  METER 1: messages_sent   (business→customer outbound + inbound handled)
  METER 2: ai_tokens       (LLM input+output tokens via LiteLLM)

  TWO-TIER GUARDRAIL per tenant:
     soft cap  →  at 80% / 100% of plan quota: in-app + email warning, agent keeps running
     hard cap  →  configurable: HARD-STOP (templated reply, no model call)  [default]
                  OR  metered overage at a published per-unit rate  [opt-in]
```

- **Internal Postgres `usage_ledger` is the source of truth** for caps; checked pre-flight in the worker (§3 ①). **Stripe meters are for invoicing only** — a Stripe lag can *never* cause an overspend.
- We **do not mark up** pass-through LLM tokens or WhatsApp message fees (avoid the thin-wrapper-at-markup trap). Token cost is recovered inside plan pricing, not resold at a margin.
- **Differentiate on transparency + spend caps.** Every plan shows a live "X of Y messages / Z of W AI-credits used this cycle" gauge in the dashboard.

> **Why two meters and not one "credit."** Messages and tokens scale independently: a chatty channel burns messages; a long-context RAG answer burns tokens. Metering both lets us cap the dimension a given tenant actually stresses, and lets the *internal* ledger map cleanly onto two Stripe meters for invoicing. We may *present* a single "AI credit" to the user in UI, but we **store and cap on the two raw meters.**

### 4.2 Plan tiers (opinionated starting point)

> Numbers are launch defaults to tune against real cost, not gospel. The *structure* — bundled AI, hard cap default, model gated by tier — is the load-bearing part.

| | **Starter** | **Growth** | **Scale** | **Enterprise** |
|---|---|---|---|---|
| Price (software only) | **$49/mo** | **$149/mo** | **$399/mo** | Custom |
| Channels | Web + Email | + WhatsApp | + Instagram + Messenger | All + priority |
| Included messages/mo | 1,000 | 5,000 | 20,000 | Negotiated |
| Included AI tokens/mo | 1M | 6M | 30M | Negotiated |
| **Model choice** | **Gemini only** (Flash) | **GPT or Gemini** | **GPT or Gemini** (incl. larger) | + Anthropic, custom routing |
| Embedding tier | `text-embedding-3-small` | `text-embedding-3-small` | `gemini-embedding-001` (quality) | quality + dedicated index |
| Hard cap default | Hard-stop | Hard-stop | Overage opt-in | Negotiated/invoiced |
| Operators (seats) | 2 | 5 | 15 | Unlimited |
| SSO (Microsoft/SAML) | – | – | – | ✅ add-on |
| Human handoff | – | ✅ | ✅ | ✅ |
| WhatsApp message fees | n/a | **billed by Meta to tenant (0 markup)** | same | same |

A separate, always-visible line in pricing copy: **"Plus your own WhatsApp message fees, billed directly by Meta — Assisty adds no markup. Utility messages inside the 24-hour window are free; real cost can run 2–5× the sticker rate."**

### 4.3 What gates the Gemini-vs-GPT choice

Model choice is **not** a free per-tenant toggle — it is a **plan-gated, LiteLLM-enforced** capability. The gate exists at four layers, so a tenant on a Gemini-only plan *cannot* reach GPT even via a tampered client:

```
  LAYER 1  PLAN          Starter ⇒ {gemini-2.5-flash}.  Growth+ ⇒ {gemini-…, gpt-…}.
  LAYER 2  LiteLLM KEY   tenant's virtual key has allowed_models = plan's allowed set
                          + a per-tenant USD budget + auto-fallback on 429/500/timeout.
  LAYER 3  TENANT CONFIG within the allowed set, operator picks a default in the dashboard.
  LAYER 4  WORKER        passes model = tenant_config.model; LiteLLM rejects anything
                          outside allowed_models (the real enforcement point).
```

**Why gate model by tier (the economic logic):**

- **Cost.** Gemini Flash is dramatically cheaper per token; GPT-class models cost more. Putting GPT behind Growth+ aligns price with our pass-through cost so the base plan stays profitable without markup.
- **Quality/positioning.** Lead with a clear, benchmark-backed model claim rather than a vague "AI." Gemini Flash is the strong, cheap default for high-volume deflection; GPT (and Anthropic on Enterprise) is the "premium reasoning" upsell.
- **No thin-wrapper trap.** Because LiteLLM gives revocable, budgeted, model-restricted virtual keys with automatic fallback, the *routing layer itself* is our value — not a markup on a single hardcoded model. A future small custom router can slot behind the same LiteLLM interface if benchmarks justify it (the Chatfuel-cascade goal, achieved without self-hosting frontier models at MVP scale).
- **Embedding tier rides along.** The quality embedding (`gemini-embedding-001`) is gated to Scale+ because switching embedding models forces a full re-embed (§2.4) — we don't want low-tier tenants thrashing the index.

### 4.4 The metering pipeline (ledger → Stripe)

```
 WORKER (same RLS txn as the reply write)
   └─ usage_ledger += { tenant_id, cycle, messages_sent: +1, ai_tokens: +N, ts }
        │  (source of truth; pre-flight cap reads this)
        ▼
   enqueue billing-meter job  ──▶  pgmq billing-meter queue
                                        │
                                        ▼
                                 Stripe Billing Meters API
                                 meter_event: { event_name:'ai_tokens',
                                   payload:{ stripe_customer_id, value:N },
                                   identifier: <idempotency key> }   ← legacy usage-records API is DEPRECATED
```

- **Idempotency:** each meter event carries a deterministic id (e.g. `wamid`+meter) so a pgmq retry can't double-bill.
- **Hot-ledger write awareness.** A viral tenant's per-message ledger increments + audit appends are a write hotspot in the worker transaction. Pre-plan **increment batching / partitioned counters** (e.g., per-tenant per-cycle counter rows, or a short in-memory aggregation window flushed to Postgres) so cap-enforcement writes don't bottleneck the turn. Read the cap from a cached counter, reconcile to Postgres on flush — Postgres remains the durable truth. (If richer queue/cache semantics are ever needed, **Upstash Redis + BullMQ** is the kept-on-file alternative.)
- **Audit, never PII.** Billing events go to the tamper-evident hash-chained `audit_log`; **never** log tokens, message bodies, or customer PII.

---

## 5. Payments platform decision: Stripe vs RevenueCat vs Google Play Billing

This is the single most consequential billing decision, and it is **already won by the architecture** — this section documents *why* and the exact compliance posture.

### 5.1 The decision

> **Use Stripe Billing directly, with checkout flows on the web (never in the Android binary). Do not use Google Play Billing. Do not use RevenueCat.**

```
                            DECISION MATRIX

  CRITERION                  Stripe Billing   Google Play Billing   RevenueCat
  ─────────────────────────  ──────────────   ───────────────────   ───────────
  B2B SaaS, web + app          ✅ purpose-fit    ❌ consumer IAP        ⚠ wraps IAP
  Usage-based metering         ✅ Meters API     ❌ no usage metering   ⚠ limited
  Platform fee on revenue      ✅ ~2.9%+30¢      ❌ 15–30%              + IAP fee on top
  Invoicing / B2B terms        ✅ first-class     ❌ none                ❌ none
  Hard spend caps / ledger     ✅ we own ledger   ❌                     ❌
  Fits Play exemption          ✅ (kept off app)  n/a                    n/a
```

### 5.2 Why not Google Play Billing — and the exemption that makes it legal

Google Play's payments policy *normally* forces in-app digital purchases through Play Billing (15–30% fee). **Assisty qualifies for two exemptions** that let us bill via Stripe with **no Google service fee**:

1. **Cloud-business-software exemption** — Assisty is B2B SaaS that businesses run their operations on (think Salesforce/Slack class), not a consumer digital good.
2. **Consumed-outside-the-app exemption** — the value (a customer-service agent answering on WhatsApp/web/email) is consumed outside the Android app; the app is a management console.

**The compliance rule that keeps the exemption valid:**

- **Keep ALL purchase/checkout/upgrade flows out of the Android binary.** The Flutter app **links out to the web** for Stripe Checkout (`url_launcher` → external browser/Custom Tab), and **must not** contain in-app purchase UI, price-with-buy-button funnels, or a Play Billing SDK.
- **Verify classification in Play Console pre-launch** (App content → Payments declaration). This is a hard gate before release; do not assume — confirm.

### 5.3 Why not RevenueCat

RevenueCat is excellent — **for consumer mobile IAP** (App Store / Play Billing subscription management across iOS/Android). It sits *on top of* the very store-billing rails we are deliberately exempt from, and it does not do **B2B usage-based metering or invoicing**. Adopting it would (a) reintroduce store fees we just avoided and (b) not solve our actual problem (two-meter usage billing with hard caps). Wrong tool for a B2B SaaS.

### 5.4 Stripe wiring summary

| Concern | Stripe primitive |
|---|---|
| Plan subscription | Products + recurring Prices; one Subscription per tenant |
| Usage metering | **Billing Meters API** (`messages_sent`, `ai_tokens`) — *not* legacy usage records |
| Checkout | Stripe-hosted Checkout (web), `checkout.session.completed` webhook |
| Customer self-service | Stripe **Customer Portal** (web link) for card/plan/invoice |
| Trials | Subscription in `trialing` status (§7.1), no card-up-front optional |
| Source of truth for caps | **Internal Postgres `usage_ledger`**, not Stripe |
| Secrets | Stripe keys in **Secret Manager**; webhook signed + verified (§1.5) |

---

## 6. Data model (the billing/onboarding slice)

> Every table below has `tenant_id`, RLS + `FORCE ROW LEVEL SECURITY`, and a `tenant_id`-led index. The app role is a dedicated tenant-scoped, non-owner, non-superuser role with no `BYPASSRLS` — and **never** Supabase `service_role`, which bypasses RLS (the same flaw that disqualified Firebase). RLS policies read the tenant from the custom JWT claim (`auth.jwt() ->> 'tenant_id'`); the edge/worker additionally `SET LOCAL app.tenant_id` per transaction and connect via the Supabase pooler (Supavisor) in transaction mode.

```sql
tenants(
  id, name, status,                       -- provisioning|active|suspended|deleted
  onboarding_state,                        -- signed_up|subscribed|channel_connected|
                                           --   form_submitted|ingesting|live
  plan, stripe_customer_id, stripe_subscription_id,
  litellm_virtual_key_ref,                 -- ref, not the key
  app_key_ref,                             -- per-tenant AES-256-GCM app key handle (crypto-shred target)
  created_at)

users(id, supabase_uid UNIQUE, email, email_verified, token_version, created_at)
memberships(user_id, tenant_id, role)      -- OWNER|ADMIN|AGENT|VIEWER   PK(user_id, tenant_id)
sessions(id, user_id, refresh_token_hash, expires_at, revoked_at)

channels(                                  -- one row per connected channel
  id, tenant_id, type,                     -- whatsapp|instagram|messenger|web|email
  status,                                  -- pending|active|error
  external_ref,                            -- phone_number_id / waba_id / page_id / domain
  enc_token_ciphertext, enc_token_iv, enc_token_tag,  -- app-level per-tenant AES-256-GCM
  vault_secret_ref)                        -- Supabase Vault (pgsodium AEAD) secret handle

tenant_config(tenant_id PK, model, embedding_model, tone, persona_notes, never_say[])
tenant_limits(tenant_id PK, plan, msg_quota, token_quota, hard_cap_mode)  -- stop|overage

kb_documents(id, tenant_id, type, source, content, updated_at)  -- product|faq|policy|hours|upload
kb_chunks(id, tenant_id, document_id, content, embedding vector(1536))  -- HNSW, tenant_id-led

usage_ledger(                              -- SOURCE OF TRUTH for caps
  tenant_id, cycle_start, messages_sent, ai_tokens, updated_at)  -- PK(tenant_id, cycle_start)
audit_log(id, tenant_id, actor, action, prev_hash, hash, ts)     -- hash-chained, no PII/tokens
```

---

## 7. Edge cases & operational rules

| Situation | Rule |
|---|---|
| **Payment fails / subscription `past_due`** | Stripe Smart Retries; on `unpaid` → `tenants.status=suspended`. Agent serves a templated "service paused" reply (no model call). Channels & tokens **retained** (don't crypto-shred on non-payment). |
| **Downgrade crosses embedding tier** | Re-embed job pinned to the new tier's model; agent stays live on the old index until the new index is built, then atomic swap. |
| **Operator removed from tenant** | Bump `users.token_version` (kills sessions) *or* delete the membership; RLS instantly stops access regardless of cached JWT until expiry (15m max). |
| **GDPR erasure (1-month path)** | Crypto-shred: destroy the tenant's app-level AES-256-GCM key ⇒ all encrypted tokens & re-encrypted PII unrecoverable; purge `kb_chunks`, conversations; audit the erasure (hash-chained). |
| **`subscribed_apps` call missed** | Channel marked `error` with explicit "no inbound webhooks — re-run connect" remediation; never a silent half-connect. |
| **Trial** (§7.1 below) | Real Stripe subscription in `trialing`; full features but a low hard cap (e.g. 200 messages) enforced by the ledger so trial spend is bounded. |
| **Outside WhatsApp 24h window** | Free-form service reply not allowed; agent must use an approved Utility/Marketing template or defer to human handoff (IG/Messenger: humans-only past 24h). |

### 7.1 Trials, framed honestly

A trial is a Stripe subscription created in `trialing` status (with or without card-up-front — recommend **no card, low hard cap** to maximize funnel completion, since the ledger bounds spend anyway). On trial end, Stripe transitions to `active` (if card on file) or the tenant drops to `suspended`. No separate trial code path — the same plan/cap machinery, just a different Stripe status and a tighter `tenant_limits` row.

---

## 8. Build order (so the funnel ships in the right sequence)

```
  PHASE A (auth + skeleton)   Supabase Auth wiring, Assisty session JWT, memberships, RLS role,
                              SET LOCAL plumbing, onboarding_state machine, GoRouter gates.
  PHASE B (billing rails)     Stripe Products/Prices, hosted Checkout (web), webhook → plan/limits,
                              LiteLLM virtual-key provisioning, usage_ledger + pre-flight cap check.
  PHASE C (channels)          Web widget + Email first (no Meta review). WhatsApp Embedded Signup
                              + the two mandatory calls + Vault + per-tenant AES-256-GCM token vault.
  PHASE D (knowledge → live)  Business-Info Form, ingest pipeline (pgmq + pg_cron worker → chunk → LiteLLM
                              embed → pgvector; uploads in Supabase Storage), structural-isolation test, smoke test, go-live flip.
  PHASE E (meter → invoice)   billing-meter queue → Stripe Meters API, soft/hard cap UX, Langfuse,
                              Customer Portal link, Play Console classification verification.
  FAST-FOLLOW                 Instagram + Messenger (post Meta App Review), CSV/Shopify catalog
                              import, overage billing, SSO add-on, n8n ingestion plane (only on demand).
```

---

## 9. Decisions this document makes (so they aren't re-litigated)

1. **Two identity surfaces**, never merged: operators (Supabase Auth, identity-only) vs end customers (channel-native, never authenticate).
2. **Assisty mints its own short-lived session JWT** on top of Supabase Auth for tenant scope + server-side revocation; authorization is **always** Postgres RLS (with a dedicated tenant-scoped role, never `service_role`), never client claims.
3. **Subscribe before connect** — no long-lived third-party tokens for non-paying accounts.
4. **Business-Info Form is the KB**: five required field groups (products, FAQs, policies, hours, tone); tone goes to the **system prompt**, everything else goes through **ingestion → pgvector**.
5. **Two meters** (`messages_sent`, `ai_tokens`); **internal ledger is the cap source of truth**, Stripe meters are invoicing-only; **hard-stop is the default** guardrail.
6. **Stripe Billing directly**, web-only checkout, **no Play Billing, no RevenueCat**, riding the cloud-software + consumed-outside-app Play exemptions (verified in Play Console pre-launch).
7. **Model choice is plan-gated and LiteLLM-enforced** — Gemini default at the low tier, GPT (then Anthropic) as the premium upsell; no markup on pass-through tokens.
8. **Re-stamp `tenant_id` on every async write**, enforce a **structural zero-rows-without-tenant** RAG test, add **Langfuse** for per-turn LLM tracing, and keep the **Retriever/repository abstraction** as the pre-planned pgvector→Qdrant escape hatch.
