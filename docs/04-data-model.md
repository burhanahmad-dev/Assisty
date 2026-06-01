# Data Model & Backend Services

> **Scope.** This document specifies the concrete data model (entities, fields, relationships, indexes, RLS) and the backend service decomposition (API edge, webhook ingest, AI worker, billing/metering) plus the contracts between them. It is the implementation contract for the winning architecture: **Assisty Custom Cloud-Native — NestJS on Cloud Run / Fly.io / Railway + Supabase Postgres 16 (pgvector) + Supabase Queues (pgmq) + pg_cron + LiteLLM**.
>
> **Backend platform decision is [ADR-0002](ADR-0002-supabase-backend.md).**
>
> **Authoritative datastore decision:** Supabase Postgres 16 is the single system of record *and* the vector store (pgvector/HNSW, built in). One stateful store, one isolation model (RLS + `FORCE ROW LEVEL SECURITY`), one backup/PITR story. Qdrant is a documented escape hatch behind a `Retriever` interface, not an MVP component.

---

## 1. Design principles (non-negotiable, in priority order)

1. **Hard per-tenant isolation.** Every tenant-scoped row carries `tenant_id`. RLS + `FORCE ROW LEVEL SECURITY` on every such table; the app connects as a **non-owner, non-superuser, `NOBYPASSRLS`** role; scope is set with **`SET LOCAL app.tenant_id`** inside each transaction (never plain `SET` — that leaks across pooled connections). Every index is **led by `tenant_id`**.
2. **Predictable horizontal scale.** Stateless edge + durable queue + stateless worker fleet on managed primitives (long-lived Node compute on Cloud Run / Fly.io / Railway; durable queue on Supabase Queues/pgmq). A slow LLM or a traffic spike never drops a webhook or blocks the 200 response.
3. **Cost control at the source.** An internal `usage_ledger` enforces hard caps *before* any model call. Stripe meters are for invoicing only and can never cause an overspend.

**Defense-in-depth invariants enforced as code/tests, not trust:**

- **Structural isolation as an invariant.** Tenant-scoped tables are **`PARTITION BY LIST (tenant_id)`** where write-hot (`messages`, `usage_ledger`, `audit_log`) or composite-PK-keyed elsewhere; the `tenant_id`-led index is a hard partition for the planner. A CI test **proves a query run without `app.tenant_id` set returns zero rows** (RLS default-deny), turning "structurally impossible to leak" into an enforced check.
- **Server-side re-stamp.** Any write originating from a less-trusted plane (ingest jobs, batch re-embed, future n8n) is **re-validated and re-stamped with `tenant_id` server-side** by the Core API; RLS is the backstop, not the only gate.
- **`tenant_id` is never model-supplied.** Every tool/function call has `tenant_id` injected server-side from the resolved session. This is the top cross-tenant leak vector and is closed by construction.

---

## 2. Logical entity model (overview)

```
                         ┌──────────────────────────┐
                         │  Tenant / Business        │  (the isolation root)
                         │  tenant_id (PK, UUID)     │
                         └────────────┬─────────────┘
        ┌──────────────┬──────────────┼───────────────┬────────────────┐
        │              │              │               │                │
        ▼              ▼              ▼               ▼                ▼
 ┌────────────┐ ┌──────────────┐ ┌──────────┐ ┌──────────────┐ ┌────────────┐
 │   User     │ │ Channel-     │ │  Agent   │ │ Subscription │ │ UsageMeter │
 │ (operator) │ │ Connection   │ │  Config  │ │  (Stripe)    │ │  (rollup)  │
 │            │ │ + enc creds  │ │ (bot)    │ │              │ │            │
 └────────────┘ └──────┬───────┘ └────┬─────┘ └──────────────┘ └────────────┘
                       │              │
                       ▼              ▼
                ┌────────────┐  ┌──────────────────┐
                │Conversation│  │ KnowledgeDoc     │
                │            │  │  └─ KnowledgeChunk│ (pgvector embedding)
                └─────┬──────┘  └──────────────────┘
                      ▼
                ┌────────────┐         ┌──────────────┐   ┌──────────────┐
                │  Message   │────────▶│ usage_ledger │   │  audit_log   │
                │            │ (token  │ (append-only │   │ (hash-chained│
                └────────────┘  cost)  │  source of   │   │  append-only)│
                                       │   truth)     │   └──────────────┘
                                       └──────────────┘
```

| Entity | Cardinality to Tenant | One-line role |
|---|---|---|
| **Tenant / Business** | — (root) | The isolation boundary. Owns a per-tenant app-level encryption key (crypto-shred boundary); everything else is scoped to it. |
| **User** | 1 Tenant → N Users | Operator/staff who log into the dashboard (Supabase Auth identity). |
| **ChannelConnection** | 1 Tenant → N Connections | One connected messaging channel (WhatsApp/IG/Messenger/Web/Email) + its app-encrypted (per-tenant AES-256-GCM) credentials. |
| **AgentConfig (Bot)** | 1 Tenant → N Agents (MVP: 1) | The bot's persona, model selection, guardrails, prompt, caps. |
| **BusinessInfo** | 1 Tenant → 1 | Structured onboarding form (name, hours, policies, address). Feeds RAG. |
| **KnowledgeDoc → KnowledgeChunk** | 1 Tenant → N Docs → N Chunks | Uploaded/scraped knowledge; chunks hold the `vector(1536)` embedding. |
| **Conversation** | 1 Tenant → N | A thread with one end customer on one channel; tracks the WhatsApp 24h window. |
| **Message** | 1 Conversation → N | A single inbound/outbound message; outbound rows carry token/cost attribution. |
| **Subscription** | 1 Tenant → 1 active | The Stripe plan, caps, model/embedding tier, channel allowance. |
| **UsageMeter (`usage_ledger`)** | 1 Tenant → N rows | Append-only ledger = **source of truth** for hard-cap enforcement. |
| **AuditLog** | 1 Tenant → N rows | Tamper-evident hash-chained security/GDPR trail (no tokens, no PII). |

---

## 3. Concrete schema (PostgreSQL 16 + pgvector)

Conventions used throughout:

- PK type is **UUID** (`gen_random_uuid()` via `pgcrypto`); timestamps are `timestamptz` defaulting `now()`.
- **Every tenant-scoped table** has `tenant_id uuid NOT NULL` as the **first column of its primary key or first index column**, RLS enabled + forced, and the canonical policy (Section 4).
- Money is never floated: cost columns are `numeric(14,6)` (micro-dollars precision for token math).
- `jsonb` is used for channel-shaped/variable payloads; promote to columns only when queried.

### 3.0 Extensions, roles, and the tenant GUC

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS vector;     -- pgvector (HNSW)
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- optional: fuzzy text fallback

-- Owner role runs migrations. App role is deliberately powerless.
CREATE ROLE assisty_app LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
-- (Supabase: connect via the pooler (Supavisor) in TRANSACTION mode so SET LOCAL
--  is scoped to the txn. The edge and AI worker authenticate as assisty_app —
--  NEVER as Supabase's service_role, which bypasses RLS.)

-- The tenant scope GUC. SET LOCAL <only> inside a txn. NEVER plain SET.
-- Example used by every worker/edge DB transaction:
--   BEGIN;
--   SELECT set_config('app.tenant_id', $1, true);  -- true => LOCAL
--   ... queries ...
--   COMMIT;
```

> **`service_role` bypasses RLS — never use it for tenant data.** Supabase's `service_role` bypasses Row Level Security entirely (the same flaw that disqualified Firebase, whose Admin SDK bypasses client-side rules). The edge and AI worker **MUST** use the dedicated tenant-scoped non-superuser `assisty_app` role with RLS enforced and `SET LOCAL app.tenant_id` per transaction, **NEVER `service_role`** for tenant data. Connect through Supabase's pooler (**Supavisor**) in **transaction mode** so `SET LOCAL` is txn-scoped.

### 3.1 `tenant` (Tenant / Business — the isolation root)

```sql
CREATE TABLE tenant (
  tenant_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name     text        NOT NULL,
  slug             citext      NOT NULL UNIQUE,          -- url-safe handle
  status           text        NOT NULL DEFAULT 'active' -- active|suspended|deleting|deleted
                     CHECK (status IN ('active','suspended','deleting','deleted')),
  -- Crypto-shredding boundary: each tenant owns its app-level AES-256-GCM key.
  -- The DB-at-rest layer is Supabase Vault (pgsodium AEAD, per-DB root key); the
  -- per-tenant app key below is the crypto-shred lever (destroy it => GDPR erasure).
  tenant_app_key_ref text      NOT NULL,   -- ref to per-tenant AES-256-GCM key (in Vault)
  region           text        NOT NULL DEFAULT 'us',
  data_residency   text        NOT NULL DEFAULT 'us',
  gdpr_erasure_due timestamptz,            -- set when an erasure request lands; <= +1 month
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- The tenant table itself is NOT RLS-scoped by app.tenant_id (it IS the scope);
-- the app role gets row access only to its own tenant via a self-referential policy.
```

> **Crypto-shredding:** destroying the tenant's `tenant_app_key_ref` (its per-tenant AES-256-GCM key in Supabase Vault) renders all of that tenant's app-encrypted credentials and any app-encrypted PII permanently unrecoverable, satisfying the GDPR 1-month erasure path without table scans. The Vault layer itself (pgsodium AEAD, per-DB root key) protects data at rest; the per-tenant app-level key is the crypto-shred lever.

### 3.2 `app_user` (User / operator)

```sql
CREATE TABLE app_user (
  tenant_id     uuid NOT NULL REFERENCES tenant(tenant_id) ON DELETE CASCADE,
  user_id       uuid NOT NULL DEFAULT gen_random_uuid(),
  auth_uid      uuid NOT NULL,             -- Supabase Auth user id; identity ONLY; authz re-enforced here
  email         citext NOT NULL,
  display_name  text,
  role          text NOT NULL DEFAULT 'member'
                  CHECK (role IN ('owner','admin','member','viewer')),
  status        text NOT NULL DEFAULT 'active',
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  UNIQUE (tenant_id, email),
  UNIQUE (auth_uid)                         -- global: one Supabase Auth identity ↦ one row
);
CREATE INDEX idx_app_user_tenant ON app_user (tenant_id, status);
```

> **Supabase Auth is identity only.** The `auth_uid` proves *who*; the `role` + `tenant_id` here decide *what*. Supabase Auth issues a JWT, and RLS policies read the tenant from a custom claim (`auth.jwt() ->> 'tenant_id'`) — but `service_role` bypasses RLS, so all authorization is **re-enforced server-side** against this table by the `assisty_app` role and is never trusted from the client.

### 3.3 `channel_connection` (ChannelConnection + encrypted credentials)

```sql
CREATE TABLE channel_connection (
  tenant_id        uuid NOT NULL REFERENCES tenant(tenant_id) ON DELETE CASCADE,
  connection_id    uuid NOT NULL DEFAULT gen_random_uuid(),
  channel_type     text NOT NULL
                     CHECK (channel_type IN ('whatsapp','instagram','messenger','web','email')),
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','active','error','revoked')),

  -- Channel routing identifiers (used to resolve tenant from inbound webhook).
  -- WhatsApp: waba_id + phone_number_id ; IG/Messenger: page_id/ig_id ;
  -- web: publishable_key ; email: inbound address.
  external_ref     jsonb NOT NULL DEFAULT '{}',  -- {waba_id, phone_number_id, page_id, ...}

  -- APP-ENCRYPTED CREDENTIALS — never plaintext. App-level AES-256-GCM under the
  -- per-tenant key (tenant.tenant_app_key_ref, held in Supabase Vault) for crypto-shred;
  -- the row is additionally protected at rest by Supabase Vault (pgsodium AEAD).
  enc_ciphertext   bytea,        -- AES-256-GCM(plaintext_token, per-tenant app key)
  enc_iv           bytea,        -- 96-bit nonce
  enc_auth_tag     bytea,        -- GCM auth tag
  cred_kind        text          -- 'wa_system_user_token' | 'page_token' | 'web_secret' | ...
                     CHECK (cred_kind IS NULL OR cred_kind IN
                       ('wa_system_user_token','page_token','web_secret','email_signing_key')),
  token_expires_at timestamptz,  -- WA System User token is effectively non-expiring

  -- Web widget keys (publishable client-side, secret server-side; HMAC identity).
  publishable_key  text,         -- safe to ship to browser
  -- secret key is stored in enc_* like any other credential

  -- WhatsApp post-onboarding state (skip subscribed_apps => no inbound webhooks).
  wa_subscribed_apps_done boolean NOT NULL DEFAULT false,
  wa_phone_registered     boolean NOT NULL DEFAULT false,

  last_verified_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id)
);
-- Tenant resolution from a shared webhook routes on these JSONB ids.
CREATE INDEX idx_chan_wa_phone ON channel_connection
  (tenant_id, ((external_ref->>'phone_number_id')))
  WHERE channel_type = 'whatsapp';
CREATE UNIQUE INDEX uq_chan_wa_phone_global ON channel_connection
  ((external_ref->>'phone_number_id'))
  WHERE channel_type = 'whatsapp' AND external_ref ? 'phone_number_id';
CREATE UNIQUE INDEX uq_chan_web_pubkey ON channel_connection (publishable_key)
  WHERE publishable_key IS NOT NULL;
```

> **Why the global unique index on `phone_number_id`.** Inbound webhooks arrive on one shared URL for all tenants. The edge resolves the tenant by looking up `phone_number_id`/`waba_id` from the payload — it must map to exactly one tenant, so the resolver lookup is the one place we read across the RLS boundary using a `SECURITY DEFINER` resolver function (see Section 5.1). The body's `tenant_id` is **never** trusted.

### 3.4 `agent_config` (Agent / Bot configuration)

```sql
CREATE TABLE agent_config (
  tenant_id        uuid NOT NULL REFERENCES tenant(tenant_id) ON DELETE CASCADE,
  agent_id         uuid NOT NULL DEFAULT gen_random_uuid(),
  name             text NOT NULL DEFAULT 'Assistant',
  is_active        boolean NOT NULL DEFAULT false,

  -- Model selection is plan-gated and maps to a LiteLLM virtual key + alias.
  litellm_virtual_key_ref text NOT NULL,   -- Supabase Vault secret ref, NOT the key itself
  chat_model       text NOT NULL DEFAULT 'gpt-4o-mini',  -- LiteLLM model alias
  fallback_model   text,                                  -- e.g. 'gemini-1.5-flash'
  embedding_model  text NOT NULL DEFAULT 'text-embedding-3-small', -- IMMUTABLE per index
  embedding_dim    int  NOT NULL DEFAULT 1536,

  -- Persona / behavior
  system_prompt    text NOT NULL,
  tone             text DEFAULT 'friendly',
  language         text DEFAULT 'auto',
  temperature      numeric(3,2) NOT NULL DEFAULT 0.30,
  max_output_tokens int NOT NULL DEFAULT 512,

  -- Guardrails / commerce
  tools_enabled    jsonb NOT NULL DEFAULT '[]',  -- ['get_order','check_inventory', ...]
  handoff_keywords text[] DEFAULT '{}',          -- escalate-to-human triggers
  rag_top_k        int NOT NULL DEFAULT 6,

  -- Hard caps (mirrored from subscription for fast pre-flight read; ledger is truth).
  monthly_msg_cap     int,
  monthly_token_cap   bigint,
  over_cap_template   text DEFAULT 'We have reached our automated-reply limit. A team member will follow up shortly.',

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, agent_id)
);
CREATE INDEX idx_agent_active ON agent_config (tenant_id) WHERE is_active;
```

> **Embedding model is immutable per index.** Changing `embedding_model` (a tier change) forces a full **per-tenant re-embed** through the ingest pipeline. Pin it per plan tier; never silently mutate it. The `embedding_dim` must match the `vector(n)` column — Matryoshka truncation (to 1536d for `gemini-embedding-001`) keeps both tiers in one column.

### 3.5 `business_info` (BusinessInfo) and `knowledge_doc` / `knowledge_chunk`

```sql
CREATE TABLE business_info (
  tenant_id     uuid PRIMARY KEY REFERENCES tenant(tenant_id) ON DELETE CASCADE,
  legal_name    text,
  description   text,
  hours         jsonb,        -- {mon:{open,close}, ...}
  address       jsonb,
  phone         text,
  website       text,
  policies      jsonb,        -- {returns, shipping, privacy_url, ...}
  raw_form      jsonb,        -- the full onboarding form snapshot
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_doc (
  tenant_id     uuid NOT NULL REFERENCES tenant(tenant_id) ON DELETE CASCADE,
  doc_id        uuid NOT NULL DEFAULT gen_random_uuid(),
  source_type   text NOT NULL CHECK (source_type IN
                  ('upload','url','form','catalog','faq','manual')),
  title         text,
  source_uri    text,         -- Supabase Storage path or crawled URL
  content_hash  text,         -- dedupe + change detection for re-embed
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','chunking','embedding','ready','error')),
  embedding_model text NOT NULL,   -- recorded so re-embed knows the source model
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, doc_id)
);
CREATE INDEX idx_doc_status ON knowledge_doc (tenant_id, status);

CREATE TABLE knowledge_chunk (
  tenant_id     uuid NOT NULL REFERENCES tenant(tenant_id) ON DELETE CASCADE,
  chunk_id      uuid NOT NULL DEFAULT gen_random_uuid(),
  doc_id        uuid NOT NULL,
  ordinal       int  NOT NULL,
  content       text NOT NULL,
  token_count   int,
  embedding     vector(1536) NOT NULL,   -- pinned dim; matches agent_config.embedding_dim
  metadata      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, chunk_id),
  FOREIGN KEY (tenant_id, doc_id) REFERENCES knowledge_doc(tenant_id, doc_id) ON DELETE CASCADE
);

-- RAG index: tenant_id-led B-tree filter + HNSW for ANN. The partial/leading
-- tenant_id makes the partition structurally evident; RLS is the backstop.
CREATE INDEX idx_chunk_tenant ON knowledge_chunk (tenant_id, doc_id);
CREATE INDEX idx_chunk_hnsw ON knowledge_chunk
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
```

> **Retrieval query (the only sanctioned RAG read):**
> ```sql
> SELECT chunk_id, content, 1 - (embedding <=> $1) AS score
> FROM knowledge_chunk
> WHERE tenant_id = current_setting('app.tenant_id')::uuid   -- explicit + RLS-backstopped
> ORDER BY embedding <=> $1                                   -- cosine distance, HNSW
> LIMIT $2;                                                   -- agent_config.rag_top_k
> ```
> Run with `SET LOCAL hnsw.ef_search = 40;` for recall/latency tuning. The `tenant_id` filter is explicit *and* RLS-enforced *and* index-led — three layers, one of which (RLS default-deny) is proven by CI to return zero rows without `app.tenant_id`.

### 3.6 `conversation` and `message`

```sql
CREATE TABLE conversation (
  tenant_id        uuid NOT NULL REFERENCES tenant(tenant_id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL DEFAULT gen_random_uuid(),
  connection_id    uuid NOT NULL,
  channel_type     text NOT NULL,
  customer_ref     text NOT NULL,   -- channel-native id (wa phone, ig psid, web visitor id)
  customer_name    text,
  status           text NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','snoozed','closed','handoff')),
  assigned_user_id uuid,            -- set on human handoff
  -- WhatsApp 24h customer-service window: free-form replies allowed until this ts.
  cs_window_expires_at timestamptz,
  last_inbound_at  timestamptz,
  last_message_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, conversation_id),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES channel_connection(tenant_id, connection_id),
  UNIQUE (tenant_id, connection_id, customer_ref)   -- one open thread per customer/channel
);
CREATE INDEX idx_conv_recent ON conversation (tenant_id, last_message_at DESC);

-- message is write-hot: LIST-partition by tenant_id for write spread + isolation.
CREATE TABLE message (
  tenant_id        uuid NOT NULL,
  message_id       uuid NOT NULL DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL,
  direction        text NOT NULL CHECK (direction IN ('inbound','outbound')),
  sender_type      text NOT NULL CHECK (sender_type IN ('customer','bot','agent','system')),
  body             text,
  content          jsonb NOT NULL DEFAULT '{}',  -- media, buttons, template payloads
  -- Idempotency / channel correlation. wamid dedupes Meta redeliveries.
  channel_msg_id   text,                          -- wamid for WhatsApp
  status           text NOT NULL DEFAULT 'received'
                     CHECK (status IN ('received','queued','sent','delivered','read','failed')),
  -- Token/cost attribution for outbound bot replies (feeds usage_ledger).
  model            text,
  prompt_tokens    int,
  completion_tokens int,
  cost_usd         numeric(14,6),
  rag_chunk_ids    uuid[],                         -- which chunks grounded this reply
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, message_id)
) PARTITION BY LIST (tenant_id);
-- Default catch-all partition; large tenants get a dedicated partition.
CREATE TABLE message_default PARTITION OF message DEFAULT;

CREATE INDEX idx_msg_conv ON message (tenant_id, conversation_id, created_at);
-- Global dedupe on the channel message id (Meta redelivery defense).
CREATE UNIQUE INDEX uq_msg_channel_id ON message (tenant_id, channel_msg_id)
  WHERE channel_msg_id IS NOT NULL;
```

> **`wamid` dedupe is two-layered.** A Postgres **idempotency table** keyed on `wamid` (INSERT ... ON CONFLICT DO NOTHING at the edge) is the fast-path dedupe (returns 200 fast, drops the redelivery before enqueue). `uq_msg_channel_id` (the unique `wamid` constraint) is the durable backstop so nothing can admit a duplicate even if the idempotency row is missing.

### 3.7 `subscription` (Stripe plan + caps + tier gating)

```sql
CREATE TABLE subscription (
  tenant_id            uuid PRIMARY KEY REFERENCES tenant(tenant_id) ON DELETE CASCADE,
  stripe_customer_id   text NOT NULL,
  stripe_subscription_id text,
  plan_code            text NOT NULL,        -- starter | growth | scale
  status               text NOT NULL DEFAULT 'trialing'
                          CHECK (status IN ('trialing','active','past_due','canceled','paused')),
  -- Plan gates (mirrored to agent_config; subscription is the authority).
  model_tier           text NOT NULL DEFAULT 'standard', -- standard(gpt/gemini-flash)|premium
  embedding_tier       text NOT NULL DEFAULT 'small',    -- small|quality
  channel_allowance    int  NOT NULL DEFAULT 1,
  monthly_msg_cap      int  NOT NULL,
  monthly_token_cap    bigint NOT NULL,
  hard_cap_behavior    text NOT NULL DEFAULT 'template'  -- template|block|notify-only
                          CHECK (hard_cap_behavior IN ('template','block','notify-only')),
  current_period_start timestamptz NOT NULL,
  current_period_end   timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_sub_stripe_customer ON subscription (stripe_customer_id);
```

> **No Google Play fee, no LLM/WhatsApp markup.** Checkout lives on the web (linked from, never embedded in, the Android binary) to preserve the Play cloud-business-software exemption. WhatsApp per-message fees bill to the tenant's own attached payment method (Meta Tech Provider model) — Assisty bills *software only* and never marks up pass-through LLM/WhatsApp cost.

### 3.8 `usage_ledger` (UsageMeter — source of truth) and `usage_rollup`

```sql
-- Append-only event ledger. NEVER updated/deleted. Partitioned by tenant for write spread.
CREATE TABLE usage_ledger (
  tenant_id     uuid NOT NULL,
  ledger_id     bigint GENERATED ALWAYS AS IDENTITY,
  meter         text NOT NULL CHECK (meter IN ('messages_sent','ai_tokens')),
  quantity      bigint NOT NULL,        -- 1 message, or token count
  cost_usd      numeric(14,6) NOT NULL DEFAULT 0,
  message_id    uuid,                   -- provenance
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  period_key    text NOT NULL,          -- 'YYYY-MM' for fast cap rollup
  stripe_meter_reported boolean NOT NULL DEFAULT false,  -- async invoicing flag
  PRIMARY KEY (tenant_id, ledger_id)
) PARTITION BY LIST (tenant_id);
CREATE TABLE usage_ledger_default PARTITION OF usage_ledger DEFAULT;
CREATE INDEX idx_ledger_cap ON usage_ledger (tenant_id, period_key, meter);
CREATE INDEX idx_ledger_unreported ON usage_ledger (tenant_id)
  WHERE stripe_meter_reported = false;

-- Pre-aggregated counters so pre-flight cap checks are O(1), not a scan of the ledger.
-- This is the write-shard/distributed-counter antidote for viral tenants:
-- workers UPSERT this rollup; the raw ledger remains the immutable audit trail.
CREATE TABLE usage_rollup (
  tenant_id      uuid NOT NULL,
  period_key     text NOT NULL,
  messages_sent  bigint NOT NULL DEFAULT 0,
  ai_tokens      bigint NOT NULL DEFAULT 0,
  cost_usd       numeric(14,6) NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, period_key)
);
```

> **Pre-flight cap check (in the same RLS txn as the turn):**
> ```sql
> SELECT messages_sent, ai_tokens
> FROM usage_rollup
> WHERE tenant_id = current_setting('app.tenant_id')::uuid
>   AND period_key = to_char(now(),'YYYY-MM');
> -- if over agent_config.monthly_*_cap => short-circuit to over_cap_template, NO model call.
> ```
> **Write-hotspot mitigation:** at low volume, increment `usage_rollup` synchronously in the turn txn. For a viral tenant, switch that tenant to **batched ledger appends + a sharded in-memory hot counter** flushed to `usage_rollup` on a `pg_cron` cadence (every N seconds), so cap writes never bottleneck the worker transaction. (Upstash Redis `INCRBY` is the kept-on-file alternative hot counter if a richer external counter is ever needed.) The raw `usage_ledger` append stays per-message (it's the audit truth); only the *counter* is sharded/batched.

### 3.9 `audit_log` (tamper-evident, hash-chained, append-only)

```sql
CREATE TABLE audit_log (
  tenant_id     uuid NOT NULL,
  seq           bigint GENERATED ALWAYS AS IDENTITY,
  actor_type    text NOT NULL,   -- user | system | worker | ingest | stripe | meta
  actor_id      text,
  action        text NOT NULL,   -- channel.connected | cred.decrypted | cap.breached | erasure.* ...
  resource      text,
  -- Hash chain: each row commits to the previous row's hash. Tampering breaks the chain.
  prev_hash     bytea NOT NULL,
  row_hash      bytea NOT NULL,  -- sha256(prev_hash || tenant_id || seq || action || details || ts)
  details       jsonb NOT NULL DEFAULT '{}',  -- NEVER tokens, NEVER PII
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, seq)
) PARTITION BY LIST (tenant_id);
CREATE TABLE audit_log_default PARTITION OF audit_log DEFAULT;
```

> Append-only is enforced with a trigger that `RAISE`s on `UPDATE`/`DELETE`, plus the app role lacking `UPDATE`/`DELETE` grants. A periodic verifier job recomputes the chain and alerts on a break. **Tokens and PII are never written here** — only references and event metadata.

---

## 4. The canonical RLS policy (applied to every tenant-scoped table)

```sql
-- Applied identically to: app_user, channel_connection, agent_config, business_info,
-- knowledge_doc, knowledge_chunk, conversation, message, subscription,
-- usage_ledger, usage_rollup, audit_log.
ALTER TABLE <tbl> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <tbl> FORCE ROW LEVEL SECURITY;        -- applies even to table owner
CREATE POLICY tenant_isolation ON <tbl>
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT ON <tbl> TO assisty_app;       -- UPDATE/DELETE granted selectively
-- audit_log / usage_ledger: INSERT only (no UPDATE/DELETE grant) => append-only at the grant level.
```

`current_setting('app.tenant_id', true)` returns `NULL` when the GUC is unset → the predicate is false → **default-deny, zero rows**. This is the invariant the CI test asserts.

**Enforced isolation test (runs in CI against an ephemeral DB):**

```sql
-- Expect: 0 rows. If this ever returns > 0, the build fails.
RESET app.tenant_id;        -- simulate a forgotten SET LOCAL
SELECT count(*) FROM knowledge_chunk;   -- must be 0
SELECT count(*) FROM message;           -- must be 0
SELECT count(*) FROM channel_connection;-- must be 0
```

---

## 5. Backend service decomposition

Four deployable services + one proxy + the queue + the store. The long-lived Node compute (edge + AI worker) runs as a separate service per role on **Cloud Run / Fly.io / Railway**, each with its own least-privilege identity. (These are long-lived Node processes — **not** Supabase Edge Functions, which are Deno, 150s-capped, and reserved for light async/ingest tasks.)

```
                            Internet (Meta, web widget, email providers, dashboard app)
                                              │
                         Edge load balancer + WAF / rate limit
                                              │
        ┌─────────────────────────────────────────────────────────────────────┐
        │  (A) API / EDGE  — NestJS (Fastify) on Cloud Run / Fly.io / Railway   │
        │  min-instances=1 (HOT PATH). concurrency=80. NO inline LLM calls.     │
        │  • REST CRUD for dashboard     • Supabase Realtime for live dashboards│
        │  • Channel onboarding (WA Embedded Signup code exchange, web keys)    │
        │  • (B) WEBHOOK INGEST: single shared /webhooks/* receiver             │
        │      verify HMAC → resolve tenant → dedupe → 200 fast → enqueue       │
        └───────────────┬───────────────────────────────────────┬─────────────┘
                        │ enqueue jobs                            │ read/write (RLS txn)
                        ▼                                         ▼
   ┌─────────────────────────────────────┐          ┌──────────────────────────────┐
   │  Supabase Queues (pgmq) + pg_cron    │          │  Supabase Postgres 16         │
   │  queues: inbound-messages, ai-turn,  │◀────────▶│  + pgvector (system of record │
   │  embeddings/ingest, outbound-send,   │          │  AND vector store)            │
   │  billing-meter, dlq                  │          │  RLS + FORCE RLS, NOBYPASSRLS │
   └───────┬───────────────────┬──────────┘          └──────────────────────────────┘
           │ ai-turn           │ outbound-send / billing-meter / ingest
           ▼                   ▼
   ┌──────────────────────┐  ┌──────────────────────────────────────────────────┐
   │ (C) AI WORKER FLEET   │  │ (D) BILLING/METER WORKER + OUTBOUND + INGEST       │
   │ NestJS worker on Cloud│  │ Cloud Run / Fly.io / Railway (scale-to-zero where │
   │ Run/Fly.io/Railway,   │  │ cold-tolerant):                                   │
   │ min-instances=1       │  │ • outbound-send: render → channel API             │
   │ (HOT PATH).           │  │ • billing-meter: report to Stripe Billing Meters  │
   │ RAG + LiteLLM + tools │  │ • ingest/re-embed: pgmq + pg_cron-driven jobs     │
   └──────────┬────────────┘  └───────────────────────────────────────────────────┘
              │ all LLM + embedding egress
              ▼
   ┌──────────────────────────────────────────┐     ┌────────────────────────────┐
   │  MODEL GATEWAY — LiteLLM Proxy             │────▶│ OpenAI / Gemini / Anthropic │
   │  per-tenant Virtual Keys (budget, revoke,  │     └────────────────────────────┘
   │  model-restrict, 429/500 auto-fallback)    │
   └──────────────────────────────────────────┘

   Cross-cutting: Supabase Vault (pgsodium AEAD + per-tenant app AES-256-GCM) •
   secrets store • logging/trace/metrics + OpenTelemetry • Langfuse (per-turn LLM
   tracing) • Supabase Auth (JWT) + FCM
```

**Min-instances cost discipline (graft from Candidate 1):** keep `min-instances=1` *only* on the webhook edge and the AI worker (the hot path). Let **ingest/embedding, outbound-send, billing-meter** workers scale to zero. Run LiteLLM Proxy HA (it is on the live egress path) — but if a cold-start-tolerant fallback path exists, allow it to scale down off-peak. This compresses the ~$900–1,500/mo always-on floor at low tenant counts.

### 5.1 (A) API / Edge service

- **Tech:** NestJS (Node 20) on **Cloud Run / Fly.io / Railway** (a long-lived process, not a Supabase Edge Function), **Fastify adapter**, behind an edge load balancer + WAF. Connects to Postgres through the Supabase pooler (Supavisor) in transaction mode as `assisty_app`. `min-instances=1`, `concurrency=80`.
- **Responsibilities:** dashboard REST CRUD; live conversations via **Supabase Realtime** (Postgres CDC over WebSocket; SSE fallback); channel onboarding (WhatsApp Embedded Signup `code` → Business Integration System User token exchange; web-widget publishable/secret key issuance); the **single shared webhook receiver** (also Section 5.2); **does no LLM work inline**.
- **Tenant resolution from a shared webhook** is the one cross-RLS read. It calls a `SECURITY DEFINER` resolver that maps `phone_number_id`/`waba_id`/`page_id`/publishable key → `tenant_id`, then everything downstream runs under `SET LOCAL app.tenant_id`. The payload's own ids are never trusted as scope.

### 5.2 (B) Webhook ingest (a responsibility of the Edge, called out separately)

Single shared URL per channel for all tenants (`/webhooks/whatsapp`, `/webhooks/meta`, `/webhooks/email`, `/webhooks/web`). Per inbound POST, the edge:

1. Reads the **raw body**, verifies `X-Hub-Signature-256` (HMAC-SHA256, **constant-time** compare, **5-min** timestamp tolerance).
2. Extracts `phone_number_id`/`waba_id` (or page/IG id) → resolves `tenant_id` (never from body scope).
3. Dedupes on `wamid` via a Postgres idempotency-table INSERT (`ON CONFLICT DO NOTHING`); durable backstop: the unique `wamid` constraint `uq_msg_channel_id`.
4. Returns **200 within ~50ms**.
5. Enqueues a normalized `inbound-messages` job on **Supabase Queues (pgmq)**. **No LLM work on the webhook thread.**

### 5.3 (C) AI worker fleet (the brain's executor)

NestJS worker as a second long-lived service on **Cloud Run / Fly.io / Railway** (`min-instances=1`; not a Supabase Edge Function). Connects as `assisty_app` through the Supabase pooler (Supavisor, transaction mode) — never `service_role`. Pulls `ai-turn` from Supabase Queues (pgmq). Per job, inside **one RLS transaction** (`SET LOCAL app.tenant_id`):

1. Load `agent_config`, recent conversation memory, and the 24h-window state.
2. **Pre-flight cap check** against `usage_rollup` → over cap ⇒ templated reply, **no model call**.
3. **RAG:** embed query via LiteLLM (tenant virtual key) → pgvector HNSW search, `tenant_id`-filtered.
4. **AI turn:** simple Q&A = one LiteLLM chat call; commerce/multi-tool = **LangGraph** bounded cyclic loop (`get_order → check_inventory → reply`). **Every tool call has `tenant_id` injected server-side** — never model-supplied.
5. Write reply (`message`) + token/cost (`usage_ledger` append + `usage_rollup` increment) in the same txn; enqueue `outbound-send`; emit a `billing-meter` job; the write surfaces to live dashboards via Supabase Realtime (Postgres CDC; SSE fallback).
6. Emit a **Langfuse** trace (prompt, retrieved chunk ids, model, tokens, cost, cap state) for per-turn LLM observability and spend-cap forensics.

### 5.4 (D) Billing / metering worker (+ outbound + ingest)

- **billing-meter:** reads unreported `usage_ledger` rows, reports `messages_sent` / `ai_tokens` to the **Stripe Billing Meters API** (legacy usage-records API is deprecated), flips `stripe_meter_reported`. Stripe is **invoicing only** — caps are enforced from the internal ledger, so Stripe lag can never cause an overspend.
- **outbound-send:** renders the canonical reply per channel and calls the channel API, respecting the 24h window (free-form service inside window; templates outside).
- **ingest / re-embed:** `pgmq` + `pg_cron`-driven jobs (and, for light/short async work, Supabase Edge Functions within the 150s Deno cap) chunk → LiteLLM embeddings → `knowledge_chunk` upsert with `tenant_id`. **Knowledge Base website re-sync** is scheduled via `pg_cron`. KB file uploads land in **Supabase Storage**. **n8n is allowed here only** (and as tenant outbound integrations), behind SSO + private networking, never publicly exposed, and the Core API **re-validates and re-stamps `tenant_id`** on every n8n-/job-originated write.

---

## 6. Inter-service APIs and contracts

### 6.1 Queue job contracts (Supabase Queues / pgmq — the internal API between services)

| Queue | Producer → Consumer | Job payload (canonical) | Idempotency key |
|---|---|---|---|
| `inbound-messages` | Edge → AI worker | `{ tenant_id, connection_id, channel_type, customer_ref, channel_msg_id, normalized_body, received_at }` | `channel_msg_id` (wamid) |
| `ai-turn` | inbound handler → AI worker | `{ tenant_id, conversation_id, message_id }` | `message_id` |
| `outbound-send` | AI worker → outbound worker | `{ tenant_id, conversation_id, message_id, channel_type, render_payload }` | `message_id` |
| `billing-meter` | AI worker → billing worker | `{ tenant_id, ledger_ids[] }` | dedup on `ledger_id` set |
| `embeddings/ingest` | Edge/Jobs → ingest worker | `{ tenant_id, doc_id, source_uri, embedding_model }` | `tenant_id+doc_id+content_hash` |

All queues use exponential backoff retries, a shared **DLQ**, and **per-tenant rate-limit groups** so one noisy tenant can't starve others. (**Upstash Redis + BullMQ** is the kept-on-file alternative if richer queue semantics than pgmq are ever needed.)

### 6.2 Edge ⇄ Dashboard (public REST + Supabase Realtime)

```
POST   /v1/channels/whatsapp/embedded-signup   {code, waba_id, phone_number_id}
        → exchanges code → System User token → envelope-encrypts → channel_connection
        → calls POST /{waba_id}/subscribed_apps  AND  POST /{phone_number_id}/register (PIN)
POST   /v1/channels/web                          → issues {publishable_key, secret_key(once)}
GET    /v1/conversations?status=open             (RLS-scoped list)
GET    /v1/conversations/:id/messages
POST   /v1/agent                                 (upsert agent_config; plan-gated model)
POST   /v1/knowledge/docs                        (upload → enqueue ingest)
GET    /v1/usage                                 (reads usage_rollup; spend + cap headroom)
GET    /v1/billing/portal                        → Stripe Billing Portal URL (web only)
SUB    realtime: conversations channel           Supabase Realtime (Postgres CDC), live turns
```

Auth: Supabase Auth JWT in `Authorization: Bearer`; the edge verifies it, loads `app_user`, and re-enforces `role` + `tenant_id` server-side (RLS policies also read the tenant from the `auth.jwt() ->> 'tenant_id'` claim, but server-side re-enforcement via `assisty_app` is authoritative — `service_role` would bypass RLS). Live updates use **Supabase Realtime (Postgres CDC over WebSocket)**, with SSE retained only as a fallback.

### 6.3 AI worker → Model Gateway (LiteLLM)

OpenAI-compatible `/chat/completions` and `/embeddings`, called with the **tenant's virtual key** (resolved from `agent_config.litellm_virtual_key_ref` via Supabase Vault). Virtual keys enforce budget, model restriction, revocation, and automatic 429/500/timeout fallback to `fallback_model`. **All LLM/embedding egress flows through LiteLLM** — it is the single token/cost logging and policy point.

### 6.4 Inbound webhook contract (Meta → Edge)

```
POST /webhooks/whatsapp
Headers: X-Hub-Signature-256: sha256=<hmac over RAW body>
Body:    { entry:[{ changes:[{ value:{ metadata:{ phone_number_id },
                       messages:[{ id: <wamid>, from, type, text/.. }] }}]}] }
Rules:   verify HMAC (constant-time, 5-min tolerance) → resolve tenant by phone_number_id
         → idempotency-table wamid dedupe (unique wamid backstop) → 200 in ~50ms
         → enqueue inbound-messages (pgmq).
```

### 6.5 Persistence abstraction (the escape hatch, made first-class)

Two interfaces bound the blast radius of future store changes:

- **`Retriever`** — `embed(text) / search(tenantId, queryVec, k) / upsert(tenantId, chunks)`. Default impl = pgvector; **Qdrant impl** (indexed `tenant_id` payload filter inside HNSW) slots behind the same interface when vector volume/latency demands it. Embedding model stays immutable per index; a tier change triggers a per-tenant re-embed job.
- **`Repository`** — per-entity data access (no raw SQL in services). This contains a future **Supabase read-replica / sharding** move to one layer rather than a re-platform.

---

## 7. Lifecycle flows (sequence sketches)

### 7.1 Inbound message → reply (the live turn)

```
Customer ──msg──▶ Meta ──webhook──▶ EDGE
  EDGE: verify HMAC → resolve tenant → idempotency-table wamid dedupe → 200 (≈50ms) → enqueue ai-turn (pgmq)
  AI WORKER (RLS txn: SET LOCAL app.tenant_id):
     load agent_config + memory + 24h-window
     pre-flight cap (usage_rollup) ──over?──▶ templated reply (NO model call) ─┐
     embed query (LiteLLM) → pgvector HNSW top-k (tenant-filtered)             │
     LLM call / LangGraph (tenant_id injected into every tool)                 │
     write message + usage_ledger append + usage_rollup increment ◀───────────┘
     enqueue outbound-send + billing-meter ; Supabase Realtime push (SSE fallback) ; Langfuse trace
  OUTBOUND WORKER: render → channel API (respect 24h window)
  BILLING WORKER (async): Stripe Billing Meters API
```

### 7.2 GDPR erasure (crypto-shredding)

```
Erasure request ──▶ set tenant.gdpr_erasure_due (<= +1 month) ──▶
  destroy tenant's per-tenant app AES-256-GCM key (Supabase Vault) ──▶ app-encrypted
  creds/PII unrecoverable ──▶ purge non-encrypted tenant rows by tenant_id
  ──▶ audit_log: erasure.completed
```

---

## 8. Decision log (opinionated, so future-me doesn't relitigate)

| Decision | Choice | Why |
|---|---|---|
| Backend platform | **Supabase Postgres** (see [ADR-0002](ADR-0002-supabase-backend.md)) | Managed Postgres with pgvector built in, Auth, Vault, Queues (pgmq), Realtime, and Storage in one platform; long-lived Node compute stays on Cloud Run / Fly.io / Railway. |
| System of record | **Supabase Postgres 16 + pgvector** (not Firestore, not separate vector DB) | Relational + metering-heavy domain; one RLS model, one PITR story; collapses surface area for a small team. |
| Tenant DB role | **Dedicated `assisty_app` (NOBYPASSRLS), never `service_role`** | Supabase `service_role` bypasses RLS (same flaw that disqualified Firebase); the edge/worker use a tenant-scoped role with `SET LOCAL app.tenant_id` through Supavisor (transaction mode). |
| Tenant scoping | **RLS + FORCE RLS + `SET LOCAL`** | `SET LOCAL` is txn-scoped (no leak across pooled conns); FORCE RLS covers the owner; default-deny on unset GUC. |
| Vector store | **pgvector/HNSW now, Qdrant behind `Retriever` later** | Avoid a second stateful store at MVP; bounded migration blast radius. |
| Credential storage | **Supabase Vault (pgsodium AEAD, per-DB root key) + app-level per-tenant AES-256-GCM** | Vault protects at rest; the per-tenant app key is the crypto-shred lever for GDPR (destroy it => unrecoverable). Never store plaintext. |
| Caps | **Internal `usage_ledger`/`usage_rollup`, enforced pre-flight** | Stripe meters lag; caps must gate *before* spend. No runaway bills. |
| Realtime | **Supabase Realtime** (Postgres CDC over WebSocket; SSE fallback) | Live dashboard updates ride Postgres change feeds without bespoke push infra; SSE remains a fallback. |
| Async work | **Supabase Queues (pgmq) + pg_cron** (Upstash Redis + BullMQ on file) | One store for queue + data; `pg_cron` drives KB website re-sync and counter flushes. Upstash + BullMQ kept on file for richer queue semantics. |
| Orchestration | **Custom NestJS worker + LangGraph for commerce only**; n8n = ingest/outbound only | n8n's AI Agent node (2–4 LLM calls, 16s+ prod, no per-tenant memory isolation) is an anti-pattern for the live turn. |
| Model access | **LiteLLM Proxy + per-tenant virtual keys** | Revocable, budgeted, model-restricted, auto-fallback; achieves "custom routing" without self-hosting a frontier cascade. |
| Billing | **Stripe Billing + Meters API, web checkout** | Google Play cloud-software exemption; no markup on pass-through WhatsApp/LLM cost (Meta Tech Provider = zero messaging markup). |
| Observability | **OpenTelemetry traces + Langfuse** | Generic OTel traces for infra; Langfuse for per-turn prompt/chunk/token/cost forensics and cap debugging. |

---

## 9. Open items / roadmap (not MVP, recorded so they aren't forgotten)

- **pgvector → Qdrant** swap behind `Retriever` when vector volume or p99 latency demands it (re-embed/re-index work; interface limits blast radius).
- **Per-tenant message/ledger partitions** for viral tenants (promote from the DEFAULT partition; pair with sharded hot-counter batching flushed via `pg_cron` for cap writes; Upstash Redis counter on file).
- **Instagram + Messenger** post Meta App Review + Business Verification (weeks–months); WhatsApp + web widget + email carry the MVP.
- **Deterministic visual flow builder** for commerce guardrails (Chatfuel/Botpress hybrid pattern) — roadmap, not MVP.
- **n8n no-redeploy ingestion plane** only if tenant demand materializes; default ingestion stays on `pgmq` + `pg_cron`-driven jobs.
- **Read replica / Supabase sharding** behind the `Repository` layer when read load or write-hotspot pressure justifies it.
