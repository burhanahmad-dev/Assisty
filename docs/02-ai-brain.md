# AI Brain, RAG, Memory & Orchestration

> **Scope.** This document specifies the AI core of Assisty: how a single inbound customer message becomes a grounded, tenant-safe reply. It covers tenant-scoped RAG (chunking, embeddings, vector store, isolation), short- and long-term conversation memory, the model-router abstraction (a tenant picks Gemini vs GPT), function/tool calling (order lookup, ticket create, human handoff), and the guardrail / anti-hallucination / PII layer. It contains the **decisive verdict on n8n vs custom orchestration** and the chosen orchestration design.
>
> **Authority.** This builds on the winning architecture — *Assisty Custom Cloud-Native (NestJS on Cloud Run / Fly.io / Railway + Supabase Postgres + pgvector + Supabase Queues)*. Where this doc and the architecture appear to differ, the architecture wins; nothing here contradicts it. The backend platform decision is **ADR-0002** (`docs/ADR-0002-supabase-backend.md`). Companion docs cover the channel layer, security baseline, and billing.

---

## 0. TL;DR for the builder

If you read nothing else:

1. **n8n is NOT the brain.** The live turn runs in a custom, stateless NestJS AI worker pulled off a Supabase Queues (pgmq) job. n8n is allowed *only* as (a) an outbound integration a tenant wires from the dashboard and (b) an optional internal ingestion/ops tool. See [§7, the verdict](#7-the-verdict-n8n-vs-custom-orchestration).
2. **One store.** Supabase Postgres 16 + `pgvector` is *both* the system of record and the vector index. One RLS security model, one backup story. Qdrant is a documented swap-in behind the `Retriever` interface — not MVP.
3. **Rent the models.** LiteLLM Proxy with per-tenant **virtual keys** is your model router. A tenant picks GPT vs Gemini per plan; you get budgets, revocation, and automatic 429/500/timeout fallback for free. No self-hosted frontier models.
4. **Isolation is layered, not trusted.** RLS + `FORCE ROW LEVEL SECURITY` + tenant-led indexes + a structural partition + **server-injected `tenant_id` on every tool call** + per-tenant LiteLLM keys. The model is *never* asked to supply a `tenant_id`.
5. **Spend is capped before the model runs.** A pre-flight read of the internal `usage_ledger` short-circuits to a templated reply if the tenant is over its hard cap. Stripe meters are for invoicing only — they can never cause an overspend.
6. **Default chat = one LLM call.** LangGraph is pulled in *only* for the cyclic multi-tool commerce path (lookup → check → answer). Simple Q&A stays a single linear call to keep p95 latency low.

---

## 1. The shape of a turn

The brain is the **AI Worker Fleet** — a stateless, long-lived NestJS Node process (hosted on Cloud Run / Fly.io / Railway, **not** Supabase Edge Functions, which are Deno, 150s-capped, and only fit light async/ingest tasks) that consumes `ai-turn` jobs from Supabase Queues (pgmq). The synchronous edge does *no* LLM work; it verifies the webhook, resolves the tenant, dedupes, returns `200` in ~50 ms, and enqueues. (Inbound channel mechanics live in the channels doc; this doc starts the moment an `ai-turn` job is picked up.)

```
                         pgmq: ai-turn job  { tenant_id, conversation_id, wamid, text, channel }
                                   |
                                   v
+---------------------------------------------------------------------------------+
|  AI WORKER  (NestJS, Cloud Run/Fly.io/Railway, stateless, warm=1, autoscale N)  |
|                                                                                 |
|  (1) OPEN TXN  ->  SET LOCAL app.tenant_id = <resolved tenant>   [RLS armed]    |
|  (2) LOAD      ->  tenant config (model, tone, plan, caps) + 24h-window state   |
|  (3) MEMORY    ->  short-term (Redis) + long-term summary (Postgres)            |
|  (4) CAP CHECK ->  read usage_ledger; if over hard cap -> templated reply, STOP |
|  (5) GUARD-IN  ->  PII scrub + injection screen on the user text                |
|  (6) RAG       ->  embed query (LiteLLM) -> pgvector HNSW WHERE tenant_id=...    |
|  (7) ROUTE     ->  classify intent: simple Q&A | commerce/multi-tool            |
|        |                                                                        |
|        +-- simple   -> ONE LiteLLM chat call (system + RAG + memory)            |
|        +-- commerce -> LangGraph bounded loop (tools, tenant_id server-injected)|
|                                                                                 |
|  (8) GUARD-OUT ->  grounding/citation check, PII redaction, refusal fallback    |
|  (9) PERSIST   ->  message row + usage_ledger increment   [same RLS txn]        |
| (10) EMIT      ->  enqueue outbound-send + billing-meter; Realtime to dashboard |
+---------------------------------------------------------------------------------+
```

Everything between steps (1) and (9) happens inside **one Postgres transaction** scoped by `SET LOCAL app.tenant_id`. The reply row and the ledger increment commit atomically: you never bill for a message you failed to persist.

> **Live dashboard transport (step 10):** the worker pushes turn updates to the operator dashboard via **Supabase Realtime (Postgres CDC over WebSocket)** — the dashboard subscribes to RLS-scoped row changes rather than the worker fanning out. **SSE remains a documented fallback** if a deployment cannot hold WebSockets.

---

## 2. Tenant-scoped RAG

RAG is where a forgotten `WHERE` clause leaks one business's price list into another's chat. We treat per-tenant isolation as a structural invariant, not a discipline.

### 2.1 The Retriever interface (escape hatch, first-class)

All vector access goes through one interface. pgvector is the MVP implementation; Qdrant is the documented swap-in when vector volume or p99 latency forces it. **Nothing in the worker imports `pgvector` directly.**

```ts
interface Retriever {
  // tenantId is ALWAYS the first argument and is supplied by the worker
  // from the resolved session — never derived from model output.
  upsert(tenantId: string, chunks: Chunk[]): Promise<void>;
  search(tenantId: string, queryVec: number[], opts: SearchOpts): Promise<ScoredChunk[]>;
  delete(tenantId: string, filter: ChunkFilter): Promise<void>;     // crypto-shred / GDPR
  reembed(tenantId: string, model: EmbeddingModel): Promise<void>;  // tier change
}

interface SearchOpts { topK: number; minScore: number; namespace?: string; }
```

This pairs with a repository/data-access layer for relational reads/writes, so the eventual `pgvector -> Qdrant` migration (and any read-replica or Supabase Postgres sharding move) is a contained blast radius, not a re-platform.

### 2.2 Chunking

Chunking quality dominates retrieval quality more than embedding model choice. Defaults:

| Source type | Strategy | Target size | Overlap | Notes |
|---|---|---|---|---|
| FAQ / Q&A pairs | One chunk per Q+A pair | natural | 0 | Never split an answer from its question. |
| Policy / docs (Markdown, HTML) | **Recursive, structure-aware** (split on `#`/`##`, then paragraph, then sentence) | ~500–800 tokens | ~80–120 tokens (~15%) | Use `langchain` `RecursiveCharacterTextSplitter` or `unstructured` for HTML/PDF. |
| Product catalog rows | One chunk per SKU; template the fields | ~150–300 tokens | 0 | `name • price • availability • short desc • key attrs`. Structured > prose for commerce. |
| Long-form articles | Semantic/heading split, then size cap | ~600 tokens | ~100 tokens | Prefer heading boundaries over fixed windows. |

Rules of thumb:

- **Prepend lightweight context to each chunk** before embedding: `"[{doc_title}] > [{section}]\n{chunk_text}"`. This recovers context lost by splitting and measurably lifts retrieval on policy docs.
- **Store the raw, un-prefixed text** for prompt injection; embed the prefixed text. Keep both.
- **Token-count with the embedding model's tokenizer**, not characters. `tiktoken` (`cl100k_base`) for OpenAI is a fine approximation across providers at this granularity.
- **Catalog re-chunks on every sync.** Treat the catalog as a derived index, not authored content; re-ingest wholesale on each pull (idempotent upsert by `source_id`).

### 2.3 Embeddings

| Tier | Model (via LiteLLM) | Dims | Cost | When |
|---|---|---|---|---|
| Default | OpenAI `text-embedding-3-small` | 1536 | ~$0.02 / 1M tokens | Every tenant unless they pay up. |
| Quality | `gemini-embedding-001` | up to 3072, **truncate to 1536** | higher | Quality plan tier only. |

- **The embedding model is immutable per index.** Switching a tenant's embedding model (a tier change) forces a **full per-tenant re-embed** through the ingest pipeline. **Pin the embedding model per plan tier** and record it on the tenant row (`tenant.embedding_model`). A tier upgrade enqueues a `Retriever.reembed(tenantId, newModel)` job; queries are served from the old index until the re-embed completes, then atomically cut over.
- **Standardize on 1536 dimensions across both models** (Matryoshka truncation of `gemini-embedding-001` to 1536) so the column type, HNSW index, and storage footprint are identical regardless of tier. This keeps one `vector(1536)` schema and one index definition.
- **Normalize vectors** and use **cosine** distance (`vector_cosine_ops`). Matryoshka-truncated vectors must be re-normalized after truncation.
- **Batch embed** during ingest (the embeddings API takes arrays); embed the single user query inline on the live turn.

### 2.4 Vector store + the isolation model

**Decision: pgvector inside the same Supabase Postgres 16 that is the system of record** (pgvector ships built-in on Supabase). Not Qdrant, not Pinecone — for the MVP. The point is to collapse the system to *one* stateful store under *one* RLS security model with *one* backup/PITR story. A solo team should not run Postgres *and* a separate vector DB.

Schema (every tenant table leads its primary/index key with `tenant_id`):

```sql
CREATE TABLE kb_chunk (
  tenant_id     uuid        NOT NULL,
  chunk_id      uuid        NOT NULL DEFAULT gen_random_uuid(),
  source_id     text        NOT NULL,         -- doc/catalog row this came from
  content       text        NOT NULL,         -- raw text (for the prompt)
  embedding     vector(1536) NOT NULL,
  metadata      jsonb       NOT NULL DEFAULT '{}',  -- {title, section, url, kind}
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, chunk_id)
) PARTITION BY HASH (tenant_id);              -- structural partition (defense in depth)

-- HNSW index leads logically with the RLS-filtered tenant_id; index per partition.
CREATE INDEX kb_chunk_embedding_hnsw
  ON kb_chunk USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

ALTER TABLE kb_chunk ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_chunk FORCE ROW LEVEL SECURITY;     -- applies even to table owner

CREATE POLICY kb_chunk_isolation ON kb_chunk
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

The query the worker actually runs (the `WHERE` is belt; RLS is suspenders; the hash partition is the structural floor):

```sql
SELECT chunk_id, content, metadata,
       1 - (embedding <=> $1) AS score
FROM kb_chunk
WHERE tenant_id = current_setting('app.tenant_id')::uuid   -- explicit
ORDER BY embedding <=> $1                                   -- cosine distance
LIMIT $2;                                                   -- topK
```

**Four layers of isolation, so a single mistake cannot leak:**

```
+-----------------------------------------------------------+
|  L4  Per-tenant LiteLLM virtual key (caps/restricts spend) |
+-----------------------------------------------------------+
|  L3  Server-injected tenant_id on every tool call          |
+-----------------------------------------------------------+
|  L2  Postgres RLS + FORCE RLS, non-owner/no-BYPASSRLS role |
|      SET LOCAL app.tenant_id per transaction               |
+-----------------------------------------------------------+
|  L1  Structural: HASH PARTITION by tenant_id + index led   |
|      by tenant_id  (the partition IS a boundary)           |
+-----------------------------------------------------------+
```

> **Enforced invariant (automated test, not trust):** a CI test opens a connection *without* setting `app.tenant_id` and asserts `SELECT count(*) FROM kb_chunk = 0`. A second test sets tenant A's id and asserts zero rows from tenant B's `source_id`. "Structurally impossible to leak" becomes a green check, not a code-review hope.

> **Pooling footgun (do not skip):** scope is set with `SET LOCAL app.tenant_id` *inside a transaction* — never plain `SET`. Plain `SET` persists on a pooled connection and leaks into the next tenant's query. Configure the pool so a connection is never reused mid-transaction. Use Supabase's pooler (**Supavisor**) in **transaction mode**.

> **service_role footgun (load-bearing):** **Supabase `service_role` bypasses RLS — the same flaw that disqualified Firebase.** The edge and AI worker MUST connect with a dedicated **tenant-scoped, non-superuser role with RLS enforced** and `SET LOCAL app.tenant_id` per transaction, **NEVER `service_role` for tenant data**. `service_role` is reserved for narrow admin/migration paths that never touch a live tenant turn.

**Async-writer re-stamp rule (defense in depth).** Any plane less trusted than the live worker — ingestion jobs, batch re-embed, future n8n flows — must have its writes **re-validated and re-stamped with `tenant_id` by the Core API**, even though RLS already backstops it. No raw insert from a job trusts its own payload's `tenant_id`.

### 2.5 When to leave pgvector

pgvector at tens of millions of vectors, or a sub-50 ms p99 at high QPS, will eventually underperform a dedicated engine. The trigger and the move:

- **Trigger:** sustained vector p95 > ~150 ms, or index build/maintenance windows hurting writes, or > ~10M vectors for a single hot tenant.
- **Move:** implement `Retriever` against **Qdrant**, using an **indexed `tenant_id` payload filter inside the HNSW graph** (Qdrant filters during traversal, preserving recall). One Qdrant collection, payload-partitioned by `tenant_id`. The worker code does not change — only the binding.

---

## 3. Conversation memory

Two horizons. Neither is ever shared across tenants or conversations.

```
            SHORT-TERM (verbatim, fast)            LONG-TERM (durable, summarized)
         +-----------------------------+        +---------------------------------+
Redis -> | key: mem:{tenant}:{conv}    |        | message (Postgres, RLS)         |
         | last N turns, raw text      |        |   full transcript, audited      | <- Postgres
         | TTL 24h, LRU-bounded        |        | conversation.summary (text)     |
         +-----------------------------+        |   rolling summary, refreshed     |
                     ^                           +---------------------------------+
                     | hydrate on cache miss              ^
                     +------------------------------------+
```

### 3.1 Short-term (working memory)

- **Store:** Redis working-memory cache (Upstash Redis on Supabase-aligned infra; this is a hot ephemeral cache, distinct from the durable Supabase Queues/pgmq work plane). Key `mem:{tenant_id}:{conversation_id}`.
- **Contents:** the last **N raw turns** (start N=8–10; tune by token budget). A Redis list, `LPUSH` + `LTRIM 0 N-1`.
- **TTL:** 24h (aligns with the WhatsApp service window; expired naturally). LRU-bounded by Redis policy.
- **Cache miss:** hydrate from the last N `message` rows in Postgres (RLS-scoped), repopulate Redis.
- **Key never contains only `conversation_id`** — always prefixed with `tenant_id`. A collision across tenants is then impossible even on a shared Redis.

### 3.2 Long-term (durable + summary)

- **System of record:** the `message` table (RLS, audited). Full transcript, append-only.
- **Rolling summary:** `conversation.summary` — a compact natural-language summary refreshed when the transcript exceeds a token threshold (e.g., every ~20 turns, summarize the oldest turns into the running summary, drop them from the prompt window). One cheap LLM call on the *summarization* model (can be the default/cheap model regardless of the tenant's chat model).
- **Prompt assembly per turn:**
  ```
  [ system prompt + tenant persona/tone ]
  [ long-term summary  (conversation.summary) ]
  [ RAG context  (top-k tenant chunks, cited) ]
  [ short-term: last N raw turns from Redis ]
  [ current user message ]
  ```
- **No global/shared memory, ever.** There is no cross-conversation "user profile" store at MVP. If a "known customer" feature is added later, it is keyed `(tenant_id, channel_user_id)` and RLS-scoped like everything else.

---

## 4. The model-router abstraction (Gemini vs GPT per tenant)

**LiteLLM Proxy is the router.** It is the single egress point for *all* LLM and embedding traffic. Self-hosted as a long-lived Node process on Cloud Run / Fly.io / Railway (run HA — `min-instances >= 1` / warm instance + health checks — because every AI turn depends on it).

### 4.1 Per-tenant virtual keys

Each tenant gets a **LiteLLM virtual key** minted at onboarding and stored encrypted. The key encodes:

| Property | Effect |
|---|---|
| **Allowed models** | Plan gates which models the tenant may call (e.g., Starter → `gemini-1.5-flash`; Pro → `gpt-4o` / `gemini-1.5-pro`). The tenant's UI choice is bounded by this. |
| **Budget** | Hard `max_budget` per key — a second backstop *below* the internal ledger cap. |
| **Rate limits** | Per-key RPM/TPM caps. |
| **Revocability** | Disable a tenant instantly without touching provider keys. |
| **Cost attribution** | LiteLLM tags every call with the tenant — feeds the usage ledger and Langfuse. |

This is Assisty's "custom routing layer." It achieves Chatfuel's proprietary-routing *goal* (revocable, budgeted, model-restricted, auto-fallback, GPT-vs-Gemini per plan) **without** self-hosting a Llama-405B cascade — unjustified ops cost at MVP/50-tenant scale. A small custom router model can slot in behind the same LiteLLM interface later if benchmarks justify it.

### 4.2 Routing, fallback, and the request

```
worker --(virtual key, model="tenant.chat_model")--> LiteLLM Proxy
                                                        |
                          +-----------------------------+------------------------------+
                          |                             |                              |
                      OpenAI                        Google Gemini                  Anthropic
                          |                             |                              |
                      429/500/timeout? --> LiteLLM auto-fallback to next in tenant's allowed list
```

- **The tenant's model choice is a config field** (`tenant.chat_model`), validated against the plan's allowed list server-side. The worker passes the model name; LiteLLM resolves provider + key.
- **Fallback is LiteLLM's job**, not the worker's: on `429/500/timeout`, it retries the next model in the tenant's allowed list. The worker sees one logical call.
- **Embeddings route through the same proxy** with the tenant's pinned embedding model.
- **Provider keys live in Supabase Vault** (pgsodium AEAD), injected into LiteLLM's runtime — never in tenant rows. Tenants hold virtual keys only.

### 4.3 Cost-aware model selection (optional, plan-driven)

A cheap classifier (or a heuristic on message length / intent) can route trivial messages to a flash/mini model and reserve the premium model for complex commerce turns — within the tenant's allowed list. Keep this off by default; turn it on per plan once Langfuse shows where spend concentrates.

---

## 5. Function / tool calling

The brain calls tools for anything it cannot answer from knowledge alone: looking up an order, opening a ticket, escalating to a human.

### 5.1 The non-negotiable rule

> **`tenant_id` is injected server-side from the resolved session into *every* tool call. The model is never asked to supply it.** This is the single highest cross-tenant leak vector. The model proposes `order_id`; the worker supplies `tenant_id`. If a tool's arguments schema even *contains* `tenant_id`, that is a bug.

```
Model output (function_call):  get_order({ "order_id": "1234" })
                                          |
                  Worker tool dispatcher merges, server-side:
                                          v
Actual invocation:  getOrder({ tenant_id: <session>, order_id: "1234" })
                                          |
                    Adapter query runs inside the RLS txn (SET LOCAL app.tenant_id)
```

### 5.2 The MVP tool set

| Tool | Model-supplied args | Server-injected | Behavior |
|---|---|---|---|
| `get_order` | `order_id` or `{email, order_number}` | `tenant_id` | Reads the tenant's commerce backend via a per-tenant **Channel/Integration adapter**; RLS-scoped. Returns status, items, tracking. |
| `check_inventory` | `sku` | `tenant_id` | Stock lookup for grounding "is X available". |
| `create_ticket` | `subject`, `body`, `priority?` | `tenant_id`, `conversation_id`, `customer_ref` | Writes a `ticket` row (RLS) and/or calls the tenant's helpdesk integration. Returns ticket id to cite to the customer. |
| `human_handoff` | `reason`, `summary` | `tenant_id`, `conversation_id` | Sets conversation state `awaiting_human`, notifies operators (FCM/dashboard), pauses the bot for this conversation. See §5.4. |

Tools are defined once as JSON-schema function definitions and passed to the model through LiteLLM (provider-agnostic tool-calling; LiteLLM normalizes OpenAI/Gemini/Anthropic tool formats). **Every tool execution is wrapped in the same RLS transaction and re-stamps `tenant_id`.**

### 5.3 Single call vs LangGraph

- **Simple Q&A and single-tool intents → one LiteLLM call** (with tools attached). If the model returns a function call, the worker executes it, appends the result, and makes one follow-up call. This covers the majority of turns and keeps p95 low.
- **Cyclic multi-tool commerce → LangGraph**, and *only* then. Example: "where's my order and can I swap the size?" → `get_order` → `check_inventory` → reply. LangGraph runs a **bounded** state machine (hard cap on iterations and total tool calls per turn — e.g., max 4 tool calls, max 2 cycles — to prevent runaway loops and runaway spend).

```
                 +-----------+      +------------------+      +-------------------+
 user intent --> | classify  | ---> | get_order        | ---> | check_inventory   |
                 +-----------+      +------------------+      +-------------------+
                       |                    |                          |
                  simple?                   +------------ reply --------+
                       |                                   |
                       v                                   v
                 single call                         bounded loop
                                              (max 4 tools / 2 cycles, then force-answer)
```

### 5.4 Human handoff (MVP boundary)

- MVP handoff is a **state flag + operator notification**, not a long-running workflow. Setting `conversation.state = 'awaiting_human'` pauses the bot for that conversation; operators reply from the dashboard; the WhatsApp **human-agent tag is humans only** (no bot automation past the 24h window).
- **Temporal is explicitly deferred.** Only adopt Temporal when a *real* long-running async handoff (spanning hours, surviving restarts, with timers/SLAs) forces it. Until then, Supabase Queues (pgmq) + a state flag is enough. Do not build for Temporal speculatively.

---

## 6. Guardrails: anti-hallucination & PII

Two gates wrap the model: **GUARD-IN** (before the model) and **GUARD-OUT** (before the reply leaves). Plus structural grounding.

```
user text --> [GUARD-IN] --> RAG+model --> [GUARD-OUT] --> reply
                 |                              |
         PII scrub of inputs            grounding/citation check
         prompt-injection screen        PII redaction of outputs
         (length / abuse checks)        refusal fallback + handoff
```

### 6.1 Anti-hallucination (grounding)

- **Grounded prompting is the primary defense.** System prompt instructs: *answer only from the provided context and conversation; if the context does not contain the answer, say you don't know and offer human handoff.* RAG context is injected with source markers.
- **Cite-or-refuse.** Each retrieved chunk carries a source id; the prompt asks the model to ground claims in the provided chunks. GUARD-OUT does a lightweight check that a substantive answer actually used retrieved context (e.g., low retrieval score → bias toward refusal/handoff rather than confident prose).
- **Retrieval floor.** If top-k max score < `minScore`, treat as "no knowledge": return a templated "I don't have that information, connecting you to a person" and (optionally) trigger `human_handoff`. Do **not** let the model free-associate.
- **Commerce facts come from tools, never memory.** Prices, stock, order status are answered from `get_order`/`check_inventory`, never paraphrased from a possibly-stale chunk.
- **Bounded tool loops** (§5.3) prevent reason-until-it-makes-something-up spirals.

### 6.2 PII handling

| Stage | Action |
|---|---|
| **Ingest** | Don't embed secrets. Knowledge base is business docs, not customer data. |
| **GUARD-IN** | Detect PII in the *inbound* customer text (email, phone, card-like, national-id patterns) with a lightweight detector (regex + `Presidio`-style recognizers; provider safety where available). Redact before sending to the LLM what the LLM doesn't need (e.g., never forward a raw card number to the model). |
| **Logs / traces** | **Never log tokens or PII.** Langfuse and OpenTelemetry traces receive redacted prompts. The hash-chained `audit_log` records *that* a turn happened, not its PII payload. |
| **GUARD-OUT** | Redact any PII the model echoes that shouldn't go back over the channel; strip internal ids the customer shouldn't see. |
| **Erasure** | GDPR erasure is satisfied by **crypto-shredding**. Encryption is layered: **Supabase Vault (pgsodium AEAD, per-DB root key)** at rest, **plus an app-level per-tenant AES-256-GCM layer** so erasure means destroying the tenant's app key → encrypted channel tokens unrecoverable, plus RLS-scoped deletes of `message`/`kb_chunk`. Documented 1-month path. |

### 6.3 Prompt-injection / jailbreak

- **Treat retrieved chunks and user text as untrusted data, not instructions.** Wrap them in clearly delimited blocks and instruct the model to ignore instructions found inside data.
- **Tool authority is server-side.** Even a fully jailbroken model cannot cross tenants: it cannot supply `tenant_id`, cannot mint a LiteLLM key, and every tool query is RLS-scoped. The blast radius of a successful injection is bounded to *that tenant's own* data and tools.
- **Langfuse traces** capture prompt + retrieved chunks per turn, which is the practical way to *detect* injection/jailbreak attempts after the fact and tune the guards.

---

## 7. THE VERDICT: n8n vs custom orchestration

**Direct answer: Do NOT use n8n as Assisty's runtime brain. Build the live turn as a custom, stateless NestJS request/response worker. This is settled.** n8n earns a place only as (a) a customer-facing **outbound integration** a tenant wires from the dashboard, and (b) an optional **internal ingestion/ops** tool for re-embedding and admin batch jobs. It never touches a customer-facing turn.

### 7.1 Why n8n loses the live turn

Two independent domains agree:

- **Architecture facts.** n8n's AI Agent node makes **2–4 LLM calls per query**; RAG adds 200–500 ms; **16s+ production response times have been reported**; its memory nodes **do not isolate per tenant** (a hard security failure for a multi-tenant SaaS); and concurrency is **fixed at startup** (no elastic scale for always-on chat).
- **Competitive facts.** No major competitor runs n8n as its internal brain. It appears only as an *external* integration (Respond.io lists it; ManyChat connects via webhooks in third-party tutorials). Chatfuel's real engine is a **custom LLM-native router** (a Llama-405B cascade on Nebius) — a workflow engine is nobody's brain.

| Axis | n8n as brain | Custom NestJS worker (chosen) |
|---|---|---|
| Latency (simple Q&A) | 2–4 LLM calls, 16s+ reported | **1 LLM call**, p95 well under n8n |
| Per-tenant memory isolation | **Not isolated** (shared memory nodes) | Keyed `(tenant_id, conversation_id)`, RLS-scoped |
| `tenant_id` on tool calls | Trusts flow wiring | **Server-injected**, model never supplies it |
| Concurrency | Fixed at startup | Elastic (Cloud Run/Fly.io/Railway autoscale + Supabase Queues) |
| Cost control | None pre-flight | **Ledger cap before the model call** |
| Tracing | Generic | Langfuse per-turn LLM tracing |

### 7.2 Where n8n is exactly right

```
        +-------------------- ASSISTY ORCHESTRATION PLANES --------------------+
        |                                                                       |
LIVE    |   Edge (NestJS) --> pgmq --> AI Worker (NestJS, +LangGraph)           |
TURN    |   custom, stateless, RLS-scoped, 1-call default      <== THE BRAIN    |
        |   n8n FORBIDDEN here                                                   |
        |.......................................................................|
INGEST  |   pgmq ingest queue + pg_cron --> worker / Edge Function (default)     |
        |   chunk -> embed (LiteLLM) -> pgvector upsert (re-stamped tenant_id)   |
        |   n8n ALLOWED later, only if no-redeploy ingestion demand appears      |
        |.......................................................................|
OUTBOUND|   Tenant-wired n8n / Make / Zapier  (Sheets, CRM, Slack exports)       |
INTEGR. |   customer-facing, opt-in, outbound only                              |
        +-----------------------------------------------------------------------+
```

- **Ingestion/re-embedding plane.** Default to the worker (or a light **Supabase Edge Function**, Deno/150s-capped, for short ingest tasks) off the Supabase Queues (pgmq) `embeddings/ingest` queue, with **pg_cron** driving Knowledge Base website re-sync. Add n8n here **only if a real tenant demand for no-redeploy ingestion iteration materializes** — don't pay the dual-ops tax prematurely.
- **Outbound integrations.** Expose n8n/Make/Zapier as **outbound** connectors a tenant configures (push a resolved conversation to a CRM, a row to Sheets, a ping to Slack). This matches how real competitors use n8n.

### 7.3 Hardening rule for any n8n / async writer

> **The Core API re-validates and re-stamps `tenant_id` on every write that originates from any less-trusted plane** (ingestion jobs, batch re-embed, future n8n). RLS already backstops it; the re-stamp is defense in depth. Additionally: any internal n8n instance runs **behind SSO + VPC, with no public webhook exposure for tenant data** — it is an ops tool, not an edge.

### 7.4 The chosen orchestration design (summary)

- **Synchronous edge (NestJS, long-lived process on Cloud Run / Fly.io / Railway):** verify HMAC, resolve tenant from `phone_number_id`/`waba_id`, dedupe on `wamid` via a **Postgres unique constraint (unique `wamid`) + an idempotency table** (not Redis `SETNX`), return `200` in ~50 ms, enqueue. No LLM work inline.
- **Durable queue (Supabase Queues / pgmq + pg_cron):** separate queues — `inbound-messages`, `ai-turn`, `embeddings/ingest`, `outbound-send`, `billing-meter` — with retries+backoff, DLQ, per-tenant rate-limit groups, idempotency. (*Upstash Redis + BullMQ* is the kept-on-file alternative if richer queue semantics are needed.)
- **AI worker (NestJS, long-lived process on Cloud Run / Fly.io / Railway):** the brain executor of §1. Single LLM call default; **LangGraph only** for the cyclic commerce path. Never a Supabase Edge Function (Deno, 150s-capped).
- **Model gateway (LiteLLM Proxy):** per-tenant virtual keys, GPT-vs-Gemini per plan, auto-fallback, cost attribution.
- **One store (Supabase Postgres + pgvector):** relational + vectors under one RLS model, behind a `Retriever` + repository abstraction for the documented Qdrant swap.
- **No Temporal, no Kubernetes, no self-hosted frontier models at MVP.**

---

## 8. Cost discipline baked into the brain

- **Pre-flight cap check.** Before any embed or chat call, the worker reads the internal `usage_ledger`. Over the hard cap → templated "limit reached" reply, **no model call**. The ledger (not Stripe) is the source of truth; a Stripe meter lag can never cause an overspend.
- **Two budget backstops below the cap:** the LiteLLM virtual-key `max_budget` per tenant, and bounded LangGraph loops.
- **Ledger write-hotspot awareness.** A viral tenant's per-message ledger increments + audit appends are a write hotspot in the worker transaction. Pre-plan **ledger increment batching or partitioned/sharded counters** so cap-enforcement writes don't bottleneck the turn. (Increment in the same RLS txn for correctness; batch the *reporting* to Stripe asynchronously via the `billing-meter` Supabase Queue / pg_cron.)
- **No markup on pass-through.** LLM and WhatsApp costs are pass-through; the brain attributes cost per tenant (LiteLLM tag → ledger) so plan pricing recovers — not marks up — spend.

---

## 9. Observability for the brain

- **Langfuse (add this).** Per-turn LLM tracing: prompt, retrieved chunks, model, tokens, cost, latency — attributed per tenant. This is materially more useful than generic traces for (a) debugging RAG quality, (b) attributing spend to the usage ledger, and (c) detecting prompt-injection/jailbreak attempts. It complements, not replaces, OpenTelemetry tracing.
- **OpenTelemetry (logs + traces + metrics) from NestJS** to the host platform's observability stack: end-to-end turn trace, alerts on queue depth, LLM latency, and cap breaches.
- **Audit:** hash-chained, append-only `audit_log` — records that a turn happened; **never tokens or PII**.

### Per-turn metrics to watch

| Metric | Why |
|---|---|
| `ai_turn` queue depth | Warm-worker / min-instances tuning; p95 latency floor |
| RAG top-k max score distribution | Retrieval quality; tune chunking / `minScore` |
| Tool-call count per turn | Detect loops; tune LangGraph bounds |
| Tokens & cost per tenant | Feed ledger; spot runaway tenants before the cap |
| Refusal / handoff rate | Anti-hallucination health; KB gap detection |
| Fallback (429/500) rate per provider | Model-router health; provider reliability |

---

## 10. Definition of done (AI core)

- [ ] Worker opens every turn with `SET LOCAL app.tenant_id` inside one transaction (dedicated tenant-scoped non-superuser role, **never `service_role`**, via Supavisor transaction mode); reply + ledger commit atomically.
- [ ] `Retriever` interface is the *only* path to vectors; pgvector implementation behind it; CI test proves a query without `app.tenant_id` returns **zero rows**.
- [ ] `kb_chunk` is hash-partitioned by `tenant_id`, RLS + FORCE RLS on, index led by `tenant_id`, `vector(1536)` cosine HNSW.
- [ ] Embedding model pinned per plan tier; tier change enqueues a per-tenant re-embed; cutover is atomic.
- [ ] Short-term memory in the Redis working-memory cache keyed `mem:{tenant_id}:{conversation_id}`, TTL 24h; long-term summary in `conversation.summary`.
- [ ] LiteLLM per-tenant virtual keys: allowed models, budget, rate limit, revocation, cost tag; GPT-vs-Gemini gated by plan.
- [ ] Tool calls: `tenant_id` server-injected on **all** of `get_order`, `check_inventory`, `create_ticket`, `human_handoff`; schemas contain no `tenant_id`.
- [ ] LangGraph used only on the commerce path; loop bounds enforced (max tools/cycles).
- [ ] GUARD-IN (PII scrub + injection screen) and GUARD-OUT (grounding/citation check + PII redaction + refusal fallback) wrap the model.
- [ ] Pre-flight ledger cap check short-circuits before any model call.
- [ ] n8n absent from the live turn; if present, only ingestion/outbound, behind SSO+VPC, with Core-API `tenant_id` re-stamp on every write.
- [ ] Langfuse tracing live alongside OpenTelemetry; no tokens/PII in any log.

---

*This document is authoritative for the AI core and is consistent with the winning architecture. Channel onboarding, the security baseline, and billing are specified in their companion documents.*
