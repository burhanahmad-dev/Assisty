# Multi-Tenancy, Security & Privacy

> **Scope.** This document is the authoritative security design for Assisty's MVP and the
> roadmap for what we deliberately defer. It builds directly on the winning architecture —
> *Custom Cloud-Native (NestJS on Cloud Run / Fly.io / Railway + Supabase Postgres + pgvector + Supabase Queues (pgmq))* — and does not contradict it.
> Everything here is opinionated and concrete: named libraries, named services, exact
> Postgres roles, exact column names. A solo/small team should be able to implement it
> verbatim.
>
> **Backend platform decision:** see ADR-0002 (`docs/ADR-0002-supabase-backend.md`).

**Audience:** the builder(s). **Posture:** P0 controls are non-negotiable and must ship in
the MVP. P1 controls have a named trigger and a roadmap slot. Anything not listed is out of
scope until a real requirement forces it in.

---

## 0. Threat model (what we are actually defending against)

We are a multi-tenant SaaS holding **other businesses' customer conversations** and
**other businesses' channel access tokens** (notably the effectively non-expiring WhatsApp
Business Integration System User token). The three things that will actually hurt us, ranked:

| # | Threat | Primary control | Backstop |
|---|--------|-----------------|----------|
| 1 | **Cross-tenant data leak** (Tenant A reads/writes Tenant B's data) | RLS + `FORCE ROW LEVEL SECURITY`, tenant-led indexes, server-injected `tenant_id` on every tool call | Per-tenant encryption boundary; automated "zero-rows-without-tenant" invariant test |
| 2 | **Channel token theft** (DB dump → tenants' WhatsApp/IG accounts hijacked) | Supabase Vault (pgsodium AEAD, per-DB root key) **plus** an app-level per-tenant AES-256-GCM layer; plaintext never persisted | Secret Manager + least-privilege SAs; crypto-shredding on erasure (delete the per-tenant app key) |
| 3 | **Forged / replayed inbound webhooks** (attacker injects fake customer messages or floods us) | HMAC-SHA256 over raw body, constant-time compare, 5-min timestamp window | Idempotency dedupe (Postgres unique `wamid` constraint + idempotency table); Cloud Armor; per-tenant rate limiting |

Secondary but real: prompt-injection causing cross-tenant tool calls (mitigated by
server-injected `tenant_id` — the model is *never* trusted with it), runaway spend
(mitigated by the pre-flight cap check against the internal ledger), and PII over-retention
(mitigated by the GDPR erasure path below).

**Explicitly out of scope for MVP:** SOC 2 / ISO 27001 certification, customer-managed
encryption keys (CMEK that the *tenant* controls), HSM-backed KMS, WAF rule tuning beyond
Cloud Armor defaults, and TikTok (no API — see research brief).

---

## 1. Tenant isolation model — Pooled DB, Bridge encryption boundary

### 1.1 The decision

```
                 SILO  <----------------------------------->  POOL
   (DB-per-tenant)        (Bridge: shared store,        (fully shared,
    max isolation,         per-tenant crypto             one row pool,
    max ops cost)          boundary)  ◄── WE ARE HERE     min isolation)

   Assisty = POOLED shared Postgres + per-tenant ENCRYPTION SILO.
   One database, one schema, one RLS policy set; the only thing that is
   physically siloed per tenant is the encryption key boundary (the per-tenant app key).
```

We run a **single Supabase Postgres (PostgreSQL 16, pgvector built-in) instance, one logical
database, one schema, one row pool** — the *Pooled* model. We lean **Bridge** by siloing
exactly one thing: the **encryption-key boundary**. Each tenant's channel tokens are wrapped
under that tenant's own app-level AES-256-GCM key (see §3), so the crypto boundary is
per-tenant even though the rows live in shared tables.

**Why Pooled, not Silo (DB-per-tenant):**

- A solo/small team cannot operate N databases, N migrations, N backup schedules, N
  connection pools. Pooled keeps **one** PITR story, **one** migration, **one** schema.
- The winning architecture's whole premise is *collapse to one stateful store under one
  security model*. Postgres + pgvector already does relational **and** vectors in one place;
  fragmenting into per-tenant DBs throws that away.
- Postgres RLS is strong enough to make Pooled safe **if and only if** every rule below is
  followed. The danger of Pooled is a single forgotten `WHERE tenant_id = …`; we defend that
  with defense-in-depth (RLS + tenant-led indexes + a structural test), not a single layer.

**Why Bridge (silo the key boundary), not pure Pooled:** it gives us
**crypto-shredding** — deleting a tenant's per-tenant app key renders their most sensitive
data (channel tokens) permanently unrecoverable, which is a clean, provable GDPR erasure
primitive (§8). It costs almost nothing (per-tenant keys are cheap) and buys a hard
blast-radius limit on token compromise.

### 1.2 Defense in depth — the six layers

A cross-tenant leak must defeat **all six** to succeed:

```
 (a) Postgres RLS + FORCE ROW LEVEL SECURITY on every tenant table
 (b) App connects as a NON-OWNER, NON-SUPERUSER role WITHOUT BYPASSRLS
 (c) Every index LED BY tenant_id (perf + structural partition signal)
 (d) Every pgvector similarity search tenant-filtered in the query, RLS as backstop
 (e) tenant_id INJECTED SERVER-SIDE into every tool/function call (model never supplies it)
 (f) Per-tenant app-level AES-256-GCM encryption boundary (Bridge), over Supabase Vault, on channel tokens
 (g) Async-writer re-stamp: any less-trusted plane (ingest jobs, future n8n) has the
     Core API RE-VALIDATE and RE-STAMP tenant_id on every write
```

> **⚠ LOAD-BEARING WARNING — service_role bypasses RLS.** Supabase's `service_role` key
> bypasses Row Level Security entirely (the *same* flaw that disqualified Firebase, whose
> Admin SDK bypasses its security rules). The synchronous edge and the AI worker **MUST**
> connect with a **dedicated tenant-scoped, non-superuser role with RLS enforced** and
> `SET LOCAL app.tenant_id` per transaction — **NEVER** `service_role` for tenant data.
> Use Supabase's pooler (**Supavisor**) in **transaction mode**. `service_role` is reserved
> for narrow, audited platform/admin operations only, never for serving tenant requests.

Authentication is **Supabase Auth** (JWT). RLS policies read the tenant from a custom JWT
claim — `auth.jwt() ->> 'tenant_id'` — and the application still re-asserts it explicitly via
`SET LOCAL app.tenant_id` per transaction (the canonical GUC below); the two are kept in sync,
never trusted from client input.

### 1.3 RLS — the exact setup (copy this)

Use one canonical session GUC: **`app.tenant_id`**. Set it with `SET LOCAL` inside the
transaction, **never** plain `SET` (plain `SET` persists on the pooled connection and leaks
into the next tenant's transaction — this is the single most dangerous footgun in a Pooled
model).

```sql
-- Roles: owner runs migrations; app role can NEVER bypass RLS.
CREATE ROLE assisty_owner LOGIN PASSWORD '...';            -- migrations / DDL only
CREATE ROLE assisty_app   LOGIN PASSWORD '...' NOBYPASSRLS NOSUPERUSER;
-- assisty_app is NOT the table owner. Owners implicitly bypass RLS unless FORCE is set.

-- Every tenant table follows this template.
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;   -- forces RLS even for the table owner

CREATE POLICY tenant_isolation ON messages
  USING      (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
-- USING gates reads/updates/deletes; WITH CHECK gates inserts/updates so a row can never
-- be written with a tenant_id other than the session's.

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO assisty_app;
-- No GRANT of BYPASSRLS, no superuser. Supabase has no SUPERUSER for app users anyway.
-- CRITICAL: assisty_app is NOT Supabase's service_role — service_role bypasses RLS. The edge
-- and AI worker connect as assisty_app (via the Supavisor pooler in transaction mode), never
-- as service_role, for any tenant data.
```

Per-transaction scoping in the NestJS worker / API (TypeORM/Prisma with a raw escape hatch):

```ts
// EVERY tenant-scoped unit of work runs inside this wrapper. No exceptions.
async function withTenant<T>(tenantId: string, fn: (tx) => Promise<T>): Promise<T> {
  return dataSource.transaction(async (tx) => {
    // SET LOCAL is transaction-scoped → cannot leak across pooled connections.
    await tx.query(`SET LOCAL app.tenant_id = $1`, [tenantId]);
    return fn(tx);
  });
}
```

**Rules that are not optional:**

- `tenant_id UUID NOT NULL` on every tenant table; **every** index begins with `tenant_id`
  (e.g. `CREATE INDEX ON messages (tenant_id, conversation_id, created_at DESC)`).
- The app role is created `NOBYPASSRLS NOSUPERUSER` and is **not** the table owner.
- `SET LOCAL` only. Lint for plain `SET app.tenant_id` in CI and fail the build.
- **Supabase Auth is identity only.** It issues the JWT (carrying a custom `tenant_id` claim
  read by RLS via `auth.jwt() ->> 'tenant_id'`); all authorization/scoping is still re-enforced
  in Postgres. Client-side Supabase rules are irrelevant here — and just as Firebase's Admin
  SDK bypassed its rules, Supabase's **`service_role` bypasses RLS**, so the server must always
  re-scope and must **never** use `service_role` for tenant data.

### 1.4 The structural-isolation invariant (enforced, not trusted)

Borrowing the "structurally impossible to leak" framing: treat the tenant filter as a hard
partition and **prove** it with an automated test that runs in CI on every migration.

```ts
// INVARIANT: a query with NO app.tenant_id set must return ZERO rows from any tenant table.
test('RLS denies all rows when tenant context is absent', async () => {
  await asAppRole(async (tx) => {
    // deliberately do NOT SET LOCAL app.tenant_id
    const r = await tx.query('SELECT count(*) FROM messages');
    expect(Number(r[0].count)).toBe(0);   // current_setting throws/empty → policy denies
  });
});
// Plus: seed Tenant A + Tenant B, set A, assert B's rows are invisible across every table.
```

This converts "we trust RLS" into "CI fails if isolation is ever broken." Run it for **every**
tenant table, automatically, from a schema-reflection loop so new tables can't be forgotten.

### 1.5 Server-injected `tenant_id` on tool calls (the top LLM leak vector)

When the AI worker does tool/function calling (e.g. `get_order`, `check_inventory`), the
`tenant_id` argument is **injected server-side from the resolved session** before the tool
executes. The LLM is **never** asked to produce it and any `tenant_id` it hallucinates is
discarded.

```ts
// The model proposes {tool: 'get_order', args: {orderNumber: '1234'}}.
// We OVERWRITE/inject tenant_id from the trusted session — the model's value is ignored.
const safeArgs = { ...model.args, tenant_id: session.tenantId };
await tools[name](safeArgs);   // tool then runs inside withTenant(session.tenantId, …)
```

### 1.6 Async-writer re-stamp (defense in depth for less-trusted planes)

Any plane less trusted than the synchronous core — ingestion/re-embed Cloud Run Jobs, and
**any future n8n ingestion** — must have its `tenant_id` **re-validated and re-stamped by the
Core API on every write**, never trusted from the job payload. RLS already backstops this,
but the re-stamp makes a compromised or buggy job structurally unable to cross tenants. Any
internal/ops n8n we stand up later lives **behind SSO + VPC with no public webhook exposure
for tenant data**.

---

## 2. Data-store security rules & row-level security

### 2.1 Tenant tables and their isolation column

Every table below carries `tenant_id UUID NOT NULL`, RLS+FORCE, the §1.3 policy, and a
`tenant_id`-led primary index:

```
tenants            (root; tenant_id = id)        channels        (per-tenant channel config)
users              (operator users, FK tenant)   conversations   (FK tenant)
channel_tokens     (encrypted; see §3)           messages        (FK tenant, conversation)
knowledge_chunks   (pgvector embedding column)   usage_ledger    (metering; see §6 hotspot)
audit_log          (hash-chained; see §7)        webhook_events  (idempotency: unique wamid + idempotency table)
```

`tenants` itself is scoped so the row's own `id` equals `app.tenant_id`; the platform/admin
plane uses a separate, audited break-glass role — never the app role.

### 2.2 pgvector retrieval — partition + filter + RLS

RAG retrieval is the highest-leverage leak surface because a forgotten filter silently
returns *someone else's knowledge base*. Three barriers:

```sql
-- knowledge_chunks(tenant_id, doc_id, chunk_no, embedding vector(1536), content text)
-- Index: HNSW, but RLS + explicit filter are what prevent leakage.
SELECT content
FROM   knowledge_chunks
WHERE  tenant_id = current_setting('app.tenant_id')::uuid   -- (1) explicit filter
ORDER  BY embedding <=> $queryEmbedding                     -- cosine distance
LIMIT  $k;
-- (2) RLS policy on knowledge_chunks denies any row that doesn't match the session anyway.
-- (3) Roadmap: LIST/HASH PARTITION knowledge_chunks BY tenant_id so isolation is structural,
--     not just policy-enforced — a forgotten WHERE then still cannot cross a partition.
```

**Embedding model is immutable per index.** Pin the embedding model **per tenant tier**
(`text-embedding-3-small` 1536d default; `gemini-embedding-001` truncated to 1536 for the
quality tier). A tier change = a full per-tenant re-embed handled by the ingest pipeline.
Store the model id on each chunk so re-embeds are auditable.

### 2.3 Repository / Retriever abstraction (bounded migration blast radius)

Make the swap-discipline a **first-class abstraction**, not a retrofit. All persistence goes
through a thin repository layer; all RAG goes through a `Retriever` interface. This bounds
two acknowledged future migrations:

```
AI worker ──▶ Retriever interface ──▶ PgVectorRetriever   (MVP)
                                   └─▶ QdrantRetriever     (swap-in when pgvector hits its
                                                            scale ceiling: tens of millions of
                                                            vectors or sub-50ms p99 at high QPS)

Services ──▶ Repository layer ──▶ Supabase Postgres (primary)
                              └─▶ read-replica / sharding move = contained behind the layer
```

When QdrantRetriever lands, isolation is re-expressed as the **indexed `tenant_id` payload
filter inside HNSW** — the same hard-partition mental model, different engine.

---

## 3. Encryption of third-party access tokens at rest (Supabase Vault + app-level per-tenant AES)

### 3.1 What we are protecting and why it's special

Channel tokens — above all the **WhatsApp Business Integration System User token** (returned
after Embedded Signup code exchange, **effectively non-expiring**) — are bearer credentials to
the *tenant's own* Meta account. A DB dump of plaintext tokens = mass account takeover. They
get the strongest control we have: **two layers — Supabase Vault (pgsodium AEAD) underneath an
app-level per-tenant AES-256-GCM layer — with crypto-shredding.**

### 3.2 The scheme

```
                    Supabase Vault (pgsodium AEAD, per-DB root key — DB-level encryption at rest)
                                       ▲  underlying storage encryption (root key never leaves the DB)
                                       │
 APP LAYER (per-tenant, for crypto-shred):
 token_plaintext ──AES-256-GCM──▶ ciphertext        DEK_plain (random 256-bit, in memory only)
        (per-tenant DEK)            + iv + auth_tag         │ wrapped by per-tenant app KEK ──▶ DEK_wrapped
                                                            ▼
 PERSIST ONLY:  ciphertext, iv, auth_tag, dek_wrapped, kek_ref, key_version
 NEVER PERSIST: token_plaintext, DEK_plain, the per-tenant app KEK in cleartext
```

- **Two layers, on purpose.** **Supabase Vault** (pgsodium AEAD, per-DB root key) gives
  transparent DB-level encryption at rest. On top of that we add an **app-level per-tenant
  AES-256-GCM** layer so the *per-tenant crypto boundary* (and therefore crypto-shred) is ours
  to control — Vault's root key is per-DB, not per-tenant, so it alone cannot give per-tenant
  erasure.
- **Algorithm:** AES-256-GCM (authenticated encryption — the auth tag detects tampering).
  Node 20 built-in `crypto.createCipheriv('aes-256-gcm', …)`. No third-party crypto lib needed;
  do **not** hand-roll AES.
- **Per-tenant DEK** (Data Encryption Key): a random 256-bit key that actually encrypts the
  token. Generated with `crypto.randomBytes(32)`.
- **Per-tenant app KEK** (Key Encryption Key): a per-tenant application-managed key that
  *wraps* the DEK. Destroying it is the crypto-shred primitive. (It may itself be stored
  sealed in Supabase Vault, but the per-tenant boundary lives at the app layer.)
- We store **only** the wrapped DEK + ciphertext + IV + auth tag + the per-tenant key
  reference + key version. Never the plaintext token, never the unwrapped DEK.

### 3.3 `channel_tokens` schema (exact fields)

```sql
CREATE TABLE channel_tokens (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  channel           text NOT NULL,              -- 'whatsapp' | 'instagram' | 'messenger' | ...
  ciphertext        bytea NOT NULL,             -- AES-256-GCM(token, DEK)
  iv                bytea NOT NULL,             -- 12-byte GCM nonce, unique per encryption
  auth_tag          bytea NOT NULL,             -- 16-byte GCM tag
  dek_wrapped       bytea NOT NULL,             -- DEK wrapped by the per-tenant app KEK
  kek_resource      text  NOT NULL,             -- per-tenant app KEK reference (e.g. vault key id 'tenant-<id>')
  kek_key_version   text  NOT NULL,             -- for rotation tracking
  created_at        timestamptz NOT NULL DEFAULT now(),
  rotated_at        timestamptz
);
ALTER TABLE channel_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_tokens FORCE ROW LEVEL SECURITY;
-- + tenant_isolation policy from §1.3
```

### 3.4 Decrypt path (per use, never cached to disk)

```
1. Load row for (tenant_id, channel).
2. Unwrap dek_wrapped with the per-tenant app KEK (kek_resource) → DEK_plain (in-memory only).
3. AES-256-GCM decrypt(ciphertext, DEK_plain, iv, auth_tag) → token_plaintext.
4. Use token for the single outbound API call. Zero the buffer. Never log it. Never persist it.
```

Unwrap/decrypt is cheap and fast; for very hot channels, an **in-memory, TTL'd** decrypted-token
cache (seconds-to-minutes, process-local, never written to disk) is acceptable — but the
default is decrypt-per-use.

### 3.5 Rotation & crypto-shredding

- **Token rotation** (tenant reconnects / Meta forces): re-encrypt under a fresh DEK, update
  the row, bump `rotated_at`.
- **KEK rotation:** rotate the per-tenant app KEK on a schedule; old versions retained only
  long enough to unwrap existing DEKs, then re-wrap lazily on next access.
- **Crypto-shredding (GDPR erasure):** **delete the tenant's per-tenant app key.** Every DEK
  wrapped by it becomes permanently unrecoverable → all that tenant's encrypted tokens are
  dead. This is our cleanest "right to erasure" primitive (§8).

---

## 4. Secrets management

**Tenant channel tokens** use the two-layer scheme above (Supabase Vault + app-level
per-tenant AES-256-GCM) and live **in Postgres** (they are per-tenant data, not platform
config). Everything below is **platform** secret material and lives in **Google Secret
Manager** — never in env files committed to git, never in container images, never in client
builds.

| Secret | Where it lives | Who can read it |
|--------|----------------|-----------------|
| Meta App Secret (webhook HMAC, OAuth) | Secret Manager | Edge SA only |
| LiteLLM master key | Secret Manager | Edge + Worker SA |
| Per-tenant LiteLLM virtual keys | Postgres (tenant-scoped) or LiteLLM's own store | Worker SA |
| Stripe secret key + webhook signing secret | Secret Manager | Billing path SA only |
| Postgres app-role credentials (assisty_app, via Supavisor pooler) | Secret Manager | Edge + Worker SA |
| Supabase `service_role` key (platform/admin only — NEVER for tenant data) | Secret Manager | Platform/admin path only |
| FCM / Firebase Admin credentials | Secret Manager | Edge SA |
| Web-widget secret keys (per tenant) | Postgres, hashed at rest | Edge SA |

**Rules:**

- **Least-privilege per-service Service Accounts.** The Edge SA, Worker SA, Ingest-Job SA,
  and Billing SA are distinct. Each gets `secretmanager.versions.access` on **only** the
  secrets it needs, and access to the per-tenant app KEK / Supabase Vault unwrap path scoped
  as tightly as the platform allows. No shared "god" SA. **No SA carries the Supabase
  `service_role` key** except the narrow platform/admin path.
- Secrets are mounted at runtime (Cloud Run / Fly.io / Railway secret refs / Secret Manager
  client), not baked into images.
- **Rotation:** Meta App Secret, Stripe keys, and LiteLLM master key are rotatable; document
  the runbook. Postgres creds rotate via Secret Manager versions.
- **Web-widget keys** follow the Chatwoot reference: a **publishable key** (client-side, safe
  to expose in the iframe loader) and a **secret key** (server-side only) used for **HMAC
  identity verification** of end users. The secret key is stored hashed; only its HMAC is ever
  computed server-side.

---

## 5. Webhook signature verification

One **shared webhook URL per channel** receives events for **all tenants**; we route by
`phone_number_id` / `waba_id` extracted **from the payload** — we **never** trust a tenant id
supplied in the body. The Edge service must verify, dedupe, return 200 fast, and process
async.

### 5.1 The verification rules (P0)

```
1. Read the RAW request body BEFORE any JSON parsing/middleware mutates it.
   (Express/Fastify: capture the raw buffer; HMAC must be over exact received bytes.)
2. Compute HMAC-SHA256(raw_body, META_APP_SECRET).
3. CONSTANT-TIME compare against X-Hub-Signature-256 (crypto.timingSafeEqual) —
   never `===` (timing side channel).
4. Timestamp tolerance: reject events whose timestamp is >5 min skewed (replay window).
5. Dedupe by event id (wamid for WhatsApp) via a Postgres UNIQUE constraint on wamid +
   an idempotency table (INSERT … ON CONFLICT DO NOTHING) — Meta REDELIVERS on non-200.
6. Resolve tenant from phone_number_id / waba_id in the payload (never from a body field).
7. Return 200 within ~50ms. Enqueue a normalized job onto Supabase Queues (pgmq). NO LLM work on this thread.
```

### 5.2 Reference implementation (NestJS / Fastify)

```ts
function verifyMetaSignature(rawBody: Buffer, header: string, appSecret: string): boolean {
  const expected = 'sha256=' +
    crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(header ?? '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);  // constant-time
}

// Edge handler (the single shared URL):
async function onWhatsappWebhook(req) {
  if (!verifyMetaSignature(req.rawBody, req.headers['x-hub-signature-256'], metaAppSecret))
    return reply.code(401).send();                      // forged → drop
  if (skewMinutes(payload.timestamp) > 5) return reply.code(200).send(); // replay → ack+drop
  // Dedupe via Postgres unique wamid + idempotency table (replaces Redis SETNX):
  const fresh = await db.query(
    `INSERT INTO webhook_events (wamid) VALUES ($1) ON CONFLICT (wamid) DO NOTHING`, [wamid]);
  if (fresh.rowCount === 0) return reply.code(200).send(); // duplicate redelivery → ack
  const tenantId = await resolveTenant(payload);         // from phone_number_id/waba_id
  await pgmq.send('inbound', normalize(payload, tenantId)); // Supabase Queues (pgmq)
  return reply.code(200).send();                         // fast 200, process async
}
```

**Stripe webhooks** use Stripe's own signing secret + `stripe.webhooks.constructEvent`
(its built-in HMAC verification) — same constant-time + replay-window discipline.

**Mandatory WhatsApp post-onboarding (not security per se, but the #1 multi-tenant failure):**
after Embedded Signup, call `POST /{waba_id}/subscribed_apps` (skipping it = no inbound
webhooks ever; no longer auto-created since late 2025) and `POST /{phone_number_id}/register`
with the 6-digit PIN.

---

## 6. Per-tenant rate limiting (P1)

Rate limiting protects three things: (a) us, from a flood DoSing the shared edge; (b) tenants,
from each other (noisy-neighbor); (c) spend, from runaway loops. It layers with the **hard
spend caps** (which are enforced separately against the usage ledger — see §6.2).

### 6.1 Token-bucket, keyed three ways

```
                         ┌─────────────────────────────────────────┐
 inbound / API request ─▶│ Cloud Armor (edge, IP/volumetric, P0)    │
                         └───────────────────┬─────────────────────┘
                                             ▼
                         ┌─────────────────────────────────────────┐
                         │ Token-bucket store, keyed:               │
                         │   rl:tenant:<tid>            (per tenant) │
                         │   rl:tenant:<tid>:user:<uid> (per user)   │
                         │   rl:tenant:<tid>:ep:<route> (per endpoint)│
                         └───────────────────┬─────────────────────┘
                                             ▼
                              429 + Retry-After   OR   proceed
```

- **Library:** `rate-limiter-flexible` — battle-tested token-bucket, atomic, supports all three
  key shapes. The hot per-request counter wants a low-latency atomic store; **Upstash Redis**
  (the kept-on-file alternative noted in ADR-0002, for when richer queue/counter semantics are
  needed) is the natural backend here, since Supabase Queues (pgmq) covers *async processing*,
  not high-QPS ingress counters. (For the *processing* side, the queue worker applies its own
  per-tenant concurrency/rate caps; this section is for the *ingress* side.)
- **Buckets:** per-tenant (overall), per-user (operator dashboard abuse), per-endpoint (e.g.
  costly export routes get a tighter bucket).
- **Limits scale with plan tier**, mirroring WhatsApp's own tier ladder (250 → 1k → 10k → 100k
  unique customers/24h; throughput ~80 msg/s default). Store limits on the tenant's plan row.
- On breach: `429` + `Retry-After`. Webhook ingress is **never** rejected with a non-200 to
  Meta (that triggers redelivery storms) — instead, shed at the worker/queue layer with the
  pgmq worker's per-tenant concurrency limiter.

### 6.2 Rate limit ≠ spend cap

Rate limiting throttles **request frequency**; the **hard spend cap** is a separate,
P0 control: the AI worker does a **pre-flight read of `usage_ledger`** and short-circuits to a
templated "limit reached" reply **before any model call** if the tenant is over cap. Caps are
enforced **before spend**, never after Stripe sees it. (Stripe Billing Meters are for invoicing
only and may lag; the internal ledger is the source of truth.)

> **Hotspot note (pre-planned).** A viral tenant's per-message `usage_ledger` increments +
> `audit_log` appends are a write hotspot inside the worker transaction. Pre-plan **ledger
> increment batching** or **partitioned/sharded counters** (e.g. per-(tenant, hour) counter
> rows summed on read) so cap-enforcement writes don't bottleneck the turn.

---

## 7. Audit logging

A **tamper-evident, hash-chained, append-only** `audit_log` table. It exists to answer "who
did what to which tenant's data, and has anyone tampered with the record?" — for security
forensics and GDPR accountability.

### 7.1 Schema and hash chain

```sql
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  actor       text NOT NULL,        -- 'user:<uid>' | 'system:worker' | 'admin:<uid>'
  action      text NOT NULL,        -- 'token.decrypt' | 'message.read' | 'tenant.erase' | ...
  target      text,                 -- e.g. 'conversation:<id>'
  metadata    jsonb,                -- NEVER tokens, NEVER PII payloads — ids/counts only
  created_at  timestamptz NOT NULL DEFAULT now(),
  prev_hash   bytea NOT NULL,       -- hash of the previous row in this tenant's chain
  row_hash    bytea NOT NULL        -- sha256(prev_hash || canonical(this row without row_hash))
);
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;   -- + tenant_isolation policy
-- App role gets INSERT + SELECT only; NO UPDATE, NO DELETE grant → append-only.
REVOKE UPDATE, DELETE ON audit_log FROM assisty_app;
```

- **Hash chain:** `row_hash = SHA-256(prev_hash || canonical_serialization(row_fields))`.
  Tampering with any historical row breaks every subsequent hash → tamper is detectable by a
  periodic chain-verification job.
- **Append-only at the grant level:** the app role has no `UPDATE`/`DELETE` on `audit_log`.
- **Never log secrets or PII payloads.** Log *that* a token was decrypted, the actor, the
  tenant, the time — **not** the token, not message bodies, not end-customer PII. This rule is
  enforced by a logging-redaction wrapper and a CI lint.

### 7.2 What to audit (minimum set)

```
token.decrypt / token.rotate / token.shred        knowledge.ingest / knowledge.reembed
auth.login / auth.failed                           billing.cap_breach / billing.cap_change
tenant.create / tenant.erase / tenant.export       admin.break_glass.* (always, loudly)
config.model_change / config.plan_change           webhook.signature_fail (security signal)
```

### 7.3 Observability that complements the audit log (not a substitute)

- **Cloud Logging + Cloud Trace + Cloud Monitoring**, **OpenTelemetry** from NestJS — traces a
  turn end-to-end; alerts on queue depth, LLM latency, cap breaches.
- **Langfuse** for **per-turn LLM tracing** (prompt, retrieved chunks, token/cost attribution
  per tenant). This is materially more useful than generic traces for (a) debugging RAG
  quality, (b) attributing spend to the usage ledger, and (c) **detecting prompt-injection /
  jailbreak attempts** that try to coax cross-tenant tool calls. Langfuse data must be
  **tenant-scoped and PII-scrubbed** like everything else.

---

## 8. GDPR — end-customer PII, deletion, residency

Assisty is a **data processor**; each tenant business is the **controller** for its own
end-customers' data. Our obligations: a signed **DPA**, a published **sub-processor list**, a
working **erasure path**, and a clear **residency** stance.

### 8.1 Where end-customer PII lives, and minimization

```
PII surface              Store            Minimization rule
─────────────────────    ──────────────   ───────────────────────────────────────────────
WhatsApp phone number    messages /       Store the channel id we need to reply; do not
 / IG handle / email      conversations    enrich or collect beyond what the channel sends.
Message content          messages         Retained per tenant's configured retention window.
KB documents (tenant's)  knowledge_chunks  Tenant-owned; deleted with the tenant.
Channel tokens           channel_tokens   Envelope-encrypted (§3); crypto-shreddable.
LLM traces               Langfuse         PII-scrubbed; tenant-scoped; short retention.
```

- **Data minimization:** collect only what a turn requires. Don't log PII to Cloud Logging or
  the audit log (§7).
- **Configurable retention:** each tenant sets a message-retention window; a **pg_cron**
  scheduled job purges expired rows.

### 8.2 Right to erasure — the documented 1-month path

GDPR Art. 17 requires erasure within **1 month**. Two levels:

```
ERASE ONE END-CUSTOMER (tenant-initiated, by channel id / phone):
  1. DELETE matching rows in messages, conversations (within withTenant tx → RLS-scoped).
  2. DELETE their chunks if any end-customer-specific data was embedded (rare).
  3. Scrub the subject from Langfuse traces.
  4. audit_log: action='enduser.erase' (ids only, no PII).

ERASE A WHOLE TENANT (offboarding):
  1. CRYPTO-SHRED: delete the tenant's per-tenant app key → all channel_tokens unrecoverable.
  2. DELETE all tenant rows (RLS-scoped cascade) OR drop the tenant's partition (§2.2 roadmap).
  3. Purge tenant traces from Langfuse; purge backups per the documented backup-expiry SLA.
  4. audit_log: action='tenant.erase'.
```

**Backups caveat (be honest in the DPA):** Supabase Postgres PITR/backups retain deleted rows
until the backup expires. State the backup-retention window in the DPA; **crypto-shredding**
covers the most sensitive class (tokens) immediately even within backups, because the key
needed to read them is gone.

### 8.3 Residency

- **MVP stance:** single region (choose an EU region — e.g. `eu-central-1` — if any early
  tenant serves EU end-customers; otherwise the founder's primary market region). The Supabase
  Postgres project (including Vault and Storage), the compute host (Cloud Run / Fly.io /
  Railway), and any ingress counter store are all **pinned to that one region**. State the
  region in the DPA.
- **LLM egress is a sub-processor concern, not residency-solved-by-region:** prompts/RAG
  context leave the region to OpenAI/Google/Anthropic. Disclose this in the sub-processor list;
  where a provider offers regional/no-training endpoints, prefer them, and ensure
  **zero-data-retention / no-training** terms via LiteLLM-routed provider settings.
- **Deferred:** true multi-region residency (EU-pinned vs US-pinned tenants on separate
  instances) is a **P2** item, triggered by an enterprise tenant contractually requiring it.

### 8.4 DPA & sub-processor list (P1, pre-revenue is fine; pre-EU-tenant is not)

Publish and keep current:

```
Sub-processors:  Supabase (Postgres, Vault, Storage, Auth, Realtime)  ·  compute host
                 (Cloud Run / Fly.io / Railway)  ·  OpenAI  ·  Google (Gemini)  ·  Anthropic
                 Stripe (billing)  ·  Meta (WhatsApp/IG/Messenger)  ·  Mailgun or SendGrid (email)
                 Upstash (if used for ingress rate-limit counters)
```

Provide a DPA template tenants can countersign and a change-notification process for new
sub-processors.

---

## 9. MVP security baseline checklist vs deferred

### 9.1 P0 — MUST ship in the MVP (non-negotiable)

| ✓ | Control | Concrete acceptance criterion |
|---|---------|-------------------------------|
| ☐ | **Pooled DB + Bridge** model chosen and documented | One Supabase Postgres instance; per-tenant app-key (AES-256-GCM over Supabase Vault) boundary live |
| ☐ | **RLS + FORCE RLS** on every tenant table | App role is `NOBYPASSRLS NOSUPERUSER`, non-owner; policy uses `current_setting('app.tenant_id')` |
| ☐ | **NEVER `service_role` for tenant data** | Edge + AI worker connect as tenant-scoped `assisty_app` via Supavisor pooler (transaction mode); `service_role` confined to audited platform/admin path |
| ☐ | **`SET LOCAL` per transaction** (never plain `SET`) | `withTenant()` wrapper used everywhere; CI lint fails on plain `SET app.tenant_id` |
| ☐ | **Every index led by `tenant_id`** | Schema review confirms; pgvector queries explicitly tenant-filtered |
| ☐ | **Structural-isolation invariant test** in CI | "No-tenant-context → zero rows" + "Tenant A can't see Tenant B" pass for every table |
| ☐ | **Server-injected `tenant_id` on all tool calls** | Tool dispatcher overwrites any model-supplied `tenant_id` |
| ☐ | **Two-layer token encryption** of channel tokens | Supabase Vault (pgsodium AEAD) + app-level AES-256-GCM under per-tenant DEK; DEK wrapped by per-tenant app KEK; only ciphertext+iv+tag+wrapped-DEK persisted |
| ☐ | **No plaintext tokens/PII ever logged** | Redaction wrapper + CI lint; verified in Cloud Logging + Langfuse |
| ☐ | **Webhook HMAC-SHA256 over raw body** | Constant-time compare, 5-min timestamp window, dedupe by `wamid` (Postgres unique constraint + idempotency table), 200 in ~50ms, async processing |
| ☐ | **WhatsApp post-onboarding calls** | `subscribed_apps` + `register` invoked; missing-subscription alarm |
| ☐ | **Secret Manager + least-privilege per-service SAs** | Distinct Edge/Worker/Ingest/Billing SAs; no shared god SA |
| ☐ | **Hard spend cap pre-flight** against `usage_ledger` | Worker short-circuits before any model call when over cap |
| ☐ | **Hash-chained append-only `audit_log`** | App role has no UPDATE/DELETE; chain-verify job runs |
| ☐ | **Cloud Armor** at the edge | Volumetric/IP protection in front of the shared webhook URL |
| ☐ | **Documented GDPR 1-month erasure path** | Both end-customer erase and tenant crypto-shred runbooks written |
| ☐ | **Async-writer `tenant_id` re-stamp** | Core API re-validates `tenant_id` on every ingest-job/batch write |

### 9.2 P1 — fast-follow, with named triggers

| Control | Trigger / when |
|---------|----------------|
| **Token-bucket rate limiting** (tenant + user + endpoint), `rate-limiter-flexible` (Upstash Redis backend for the ingress counter) | At first sign of noisy-neighbor or abusive traffic; before scaling past a handful of tenants |
| **Published DPA + sub-processor list** | Before the **first EU end-customer** touches the system (legal hard gate), or first paying tenant |
| **Langfuse per-turn LLM tracing** | As soon as RAG quality / spend-attribution debugging needs it (early — it's cheap to add) |
| **Ledger write-shard / increment batching** | When a single tenant's message volume makes `usage_ledger` a write hotspot |
| **Per-tenant app KEK + Stripe/Meta key rotation runbooks** | Before first external security review or first enterprise prospect |
| **n8n ingestion plane behind SSO + VPC** (re-stamp enforced) | Only if tenant demand for no-redeploy ingestion iteration materializes |

### 9.3 Deferred (explicitly out of scope until forced)

| Item | Why deferred / unblock trigger |
|------|-------------------------------|
| **SOC 2 / ISO 27001** | No certification need at MVP; trigger = enterprise procurement requirement |
| **Customer-managed (tenant-controlled) keys / HSM-backed KMS** | Per-tenant app KEK already gives crypto-shred; trigger = enterprise key-custody requirement |
| **True multi-region residency** (EU-pinned vs US-pinned instances) | MVP is single-region; trigger = enterprise contractual residency clause |
| **Self-hosted frontier model / custom router** | LiteLLM over hosted providers achieves the routing goal; trigger = benchmark-justified cost case |
| **Per-tenant partitioned `knowledge_chunks` / `messages`** | RLS + tenant-led indexes suffice at MVP scale; trigger = scale or stronger structural-isolation requirement |
| **Temporal for long-running handoff** | Supabase Queues (pgmq) + pg_cron cover MVP async; trigger = real hours-spanning human-handoff use case |
| **Qdrant swap** (behind the `Retriever` interface) | pgvector fine to tens of millions of vectors; trigger = >50ms p99 at high QPS / volume ceiling |
| **TikTok DM** | No open API, geo-blocked (US/EEA/UK/CH), partner-gated — do not promise it |

---

## 10. One-page summary (pin this above the desk)

```
ISOLATION   Pooled Postgres, Bridge crypto boundary. RLS + FORCE RLS everywhere.
            App role NOBYPASSRLS/NOSUPERUSER/non-owner. SET LOCAL app.tenant_id per txn.
            Every index led by tenant_id. tenant_id injected server-side on tool calls.
            CI proves "no context → zero rows."

TOKENS      Supabase Vault (pgsodium AEAD) + app-level AES-256-GCM under per-tenant DEK,
            DEK wrapped by per-tenant app KEK. Persist ciphertext+iv+tag+wrapped-DEK only.
            Crypto-shred (delete the per-tenant app key) to erase.

WEBHOOKS    HMAC-SHA256 over RAW body, timingSafeEqual, 5-min window, dedupe on wamid
            (Postgres unique constraint + idempotency table), 200 in ~50ms, process async
            via Supabase Queues (pgmq). Route by phone_number_id (never a body tenant id).

SECRETS     Secret Manager + least-privilege per-service SAs. Tokens in Postgres (encrypted).
            NEVER service_role for tenant data — assisty_app via Supavisor (transaction mode).

LIMITS      Cloud Armor (P0) + token-bucket per tenant/user/endpoint (P1, Upstash Redis backend).
            Hard spend cap = pre-flight ledger read BEFORE the model call (P0).

AUDIT       Hash-chained, append-only audit_log. Never log tokens/PII. + Langfuse + OTel.

GDPR        Data minimization, configurable retention, 1-month erasure (end-customer DELETE
            + tenant crypto-shred). Single-region MVP. DPA + sub-processor list before EU.
```
