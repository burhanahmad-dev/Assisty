# Assisty — Knowledge Base & Data Sources

> **Scope.** This document specifies the **Knowledge Base (KB)** module: the multi-source hub a business owner uses to *train* their Assisty agent. It covers the eight Data Sources (Business Profile, Catalog, FAQ, Policies, Tone/Persona, Website Scan, File Upload, Learn-from-Conversations), the review/approve trust gate, re-sync & freshness, the ingest pipeline, the data model, the dashboard tab, the Supabase-specific mechanics, and the website-as-channel-vs-source distinction.
>
> **Authority.** This builds on the winning architecture as amended by [ADR-0002](./ADR-0002-supabase-backend.md) (Supabase = Postgres + pgvector + RLS + Auth + Storage + Queues(`pgmq`) + `pg_cron` + Edge Functions + Vault). RAG mechanics (chunking, embeddings, the `Retriever` interface, isolation) are owned by [02-ai-brain.md](./02-ai-brain.md); the base schema (`business_info`, `knowledge_doc`, `knowledge_chunk`) is owned by [04-data-model.md](./04-data-model.md). This doc **extends**, never contradicts, those. Where this and the AI-brain/data-model docs differ, they win.

---

## 0. TL;DR for the builder

1. **The KB is RAG, not fine-tuning.** "Training the bot" means *retrieval over the tenant's own indexed content at answer time* — never modifying model weights. Repeat this in the UI copy. A business owner who edits a price expects the answer to change in seconds, not after a training run.
2. **Multi-source hub, one pipeline.** Eight tabs feed **one** canonical ingest path: `kb_document(type) → chunk → embed (LiteLLM) → pgvector upsert (RLS-scoped, tenant_id re-stamped)`. Don't write eight ingesters.
3. **Everything auto-extracted lands `draft`/`disabled`.** Only **approved** rows become retrievable. This single rule is what makes website-crawl and learn-from-conversations safe to ship.
4. **Two facts never go through the LLM:** "are you open?" (answered from structured `hours` metadata) and "where's my order / is X in stock / what's the price" (answered from tools, see [02-ai-brain §5](./02-ai-brain.md#5-function--tool-calling)). The KB grounds *everything else*.
5. **Tone/persona is NOT embedded.** It is injected into the system prompt and carries a hard **"never say"** guardrail list. Embedding persona text would pollute retrieval.
6. **Freshness is non-negotiable.** A stale chunk that quotes last month's price is worse than no chunk. `pg_cron` re-crawls on a schedule, diffs by `content_hash`, and re-embeds only what changed.
7. **`service_role` bypasses RLS.** Every ingest writer (Edge Function, crawler, conversation-miner) runs as a non-superuser RLS role and **re-stamps `tenant_id` server-side**. Never let a job trust the `tenant_id` in its own payload.

---

## 1. Purpose & mental model

### 1.1 The KB is the agent's brain — and the brain is a library, not a memory

The Knowledge Base is the agent's **brain**: the sum of everything it is allowed to know about *this* business. But the way it "knows" is specific and worth being pedantic about, because it shapes every UX and infra decision:

> **The agent does not memorize your business. It looks things up.** At answer time, the customer's question is embedded, the most relevant chunks of *your* indexed content are retrieved, and the model is asked to answer **only from those chunks** (see the grounding rules in [02-ai-brain §6.1](./02-ai-brain.md#61-anti-hallucination-grounding)). This is **Retrieval-Augmented Generation (RAG)**. It is **not** model fine-tuning.

Why this framing is load-bearing, not pedantry:

| If you (wrongly) thought it was fine-tuning… | …the RAG reality is |
|---|---|
| "Editing a price means re-training; takes hours." | Edit a row → re-embed **one chunk** → live in seconds. |
| "Adding a doc risks the bot forgetting other things." | Sources are independent; adding one never degrades another. |
| "The model 'learns' my data and could leak it to others." | Chunks are RLS-partitioned by `tenant_id`; nothing crosses tenants, nothing enters shared weights. |
| "I must give it everything up front." | Sources are incremental and individually toggleable. |
| "Wrong answers mean the model is broken." | Wrong answers are almost always a **KB gap or a stale chunk** — fixable by the owner, observable as a low retrieval score. |

The KB is therefore a **multi-source hub**: a set of *Data Sources*, each a tab in the dashboard, each independently editable, re-syncable, and enable/disable-able, all flowing into one shared vector index that the live turn retrieves from.

### 1.2 How the competitors actually do it (and what we copy)

| Capability | **Chatfuel** | **Intercom Fin** | **Tidio Lyro** | **Assisty (this doc)** |
|---|---|---|---|---|
| Top-level concept | Structured *About Company* / *Catalog* / *FAQ* blocks | **Knowledge Hub** (articles, snippets, PDFs) + **Website Sync** | **Data Sources** tab | **Data Sources** hub (8 tabs) |
| Structured business facts | About Company fields | Profile/snippets | Business info form | **Business Profile** (structured columns + 1 synth chunk) |
| Products | Catalog (manual + sync) | (via content) | (via scan/links) | **Catalog** (rows + CSV + roadmap Shopify/Woo) |
| Q&A | FAQ block | Articles → answers | Q&A pairs | **FAQ** (1 chunk/pair) |
| Website ingest | URL import | **Website Sync** (crawl + auto-refresh) | URL scan → auto Q&A | **Website Scan/Sync** (crawl → AI-extract → Q&A) |
| Files | — | PDF upload | File upload | **File Upload** (PDF/DOCX/TXT) |
| Learn from chats | — | Suggested content from conversations | **Q&A learned from conversations (owner approves)** | **Learn-from-Conversations** (draft, owner-approved) |
| Approve before live | (manual content) | Draft → publish workflow | **Pending review** before active | **`draft`/`disabled` → `approved`** gate on *all* auto-extracted items |
| Mechanism | RAG over indexed blocks | RAG over Knowledge Hub | RAG over Data Sources | **RAG** (pgvector), never fine-tuning |

**The synthesis we ship:** Chatfuel's *structured* business/catalog/FAQ blocks (clean schema beats prose for commerce) + Intercom's crawl-and-auto-refresh Website Sync + Tidio's **review-before-active** trust gate on everything auto-imported. None of them fine-tune; neither do we.

---

## 2. The Data Sources

Each Data Source is a tab in the dashboard and a `type` on the canonical `kb_document` row. The **Business Profile** tab is the structured spine seeded by the onboarding Business-Info Form (see [05-onboarding-billing §"Activate"](./05-onboarding-billing.md)); the rest extend it.

```
                         ASSISTY KNOWLEDGE BASE  (one tenant's "brain")
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │  DATA SOURCE TABS (dashboard)                                                  │
  │                                                                                │
  │  (a) Business Profile   structured cols + 1 synth chunk + hours metadata       │
  │  (b) Catalog            rows / CSV / [roadmap] Shopify·Woo  → 1 chunk / product │
  │  (c) FAQ                Q/A pairs                           → 1 chunk / pair    │
  │  (d) Policies           returns·shipping·warranty·privacy   → section chunks    │
  │  (e) Tone / Persona     NOT embedded → injected into system prompt + "never say"│
  │  (f) Website Scan/Sync  crawl → AI-extract → Q&A/chunks  (review-gated)         │
  │  (g) File Upload        PDF·DOCX·TXT → Storage → ingest  (review-gated)         │
  │  (h) Learn-from-Convos  resolved chat → candidate Q&A   (DISABLED by default)   │
  └───────────────┬────────────────────────────────────────────────────────────────┘
                  │  (a–d,f,g,h)            (e) bypasses the index
                  ▼                          │
        CANONICAL INGEST PIPELINE (§5)        └────────► system prompt assembly (live turn)
        kb_document(type) → chunk → embed → pgvector upsert (RLS, tenant_id re-stamped)
```

### (a) Business Profile — STRUCTURED, with a synthesized chunk *and* queryable metadata

The single most valuable source. It is the onboarding form, made permanent and editable.

**Stored three ways at once** (this triple-storage is the point):

1. **Structured columns** on `business_info` (queryable, never hallucinated):

   | Field | Type | Example |
   |---|---|---|
   | Business name | `text` | "Kareem's Coffee Roasters" |
   | Phone / Email | `text` | `+1-555-0100` / `hi@kareems.coffee` |
   | Address | `jsonb` | `{line1, city, region, postal, country}` |
   | Socials | `jsonb` | `{instagram, x, tiktok, facebook}` |
   | Hours + timezone | `jsonb` | `{tz:"America/New_York", mon:{open:"08:00",close:"17:00"}, ...}` |
   | Payment options | `text[]` | `{visa, mastercard, applepay, cod}` |
   | Website URL | `text` | `https://kareems.coffee` |

2. **One small synthesized chunk** — the server templates the structured fields into a single natural-language paragraph, embeds it, and upserts it as a `kb_document(type='business_profile')` with exactly one chunk. This lets "what's your address / how do I pay / what's your Instagram?" be answered by normal RAG.

3. **Hours as structured metadata** so *"are you open right now?"* needs **no LLM call and no retrieval at all**. A deterministic resolver reads `hours` + `tz`, compares against `now()`, and returns open/closed/next-open directly. This is faster, free, and never wrong.

```
"are you open?" ──► intent: hours_check ──► read business_info.hours + tz
                                            └► deterministic open/closed/next-open  (no LLM, no RAG)
```

> **Re-synthesize on edit.** Any structured-field change re-templates and re-embeds the single profile chunk (idempotent upsert). One chunk, one embed call — cheap.

### (b) Catalog — products / services

| Field | Required | Notes |
|---|---|---|
| `name` | ✅ | Product/service name. |
| `price` | optional | `numeric` + `currency`; nullable for "contact us" pricing. |
| `availability` | optional | `in_stock` / `out_of_stock` / `preorder` / `discontinued`. |
| `short_description` | ✅ | One or two sentences; what it is / who it's for. |
| `url` | optional | Deep link to the product page. |

**Ingest methods, in shipping order:**

1. **Manual rows** — add/edit in a table UI (the onboarding fast path).
2. **CSV import** — column-map → validate → bulk insert; each row becomes a catalog row.
3. **[Roadmap] live Shopify / WooCommerce sync** — a connector pulls the product feed on a `pg_cron` schedule, re-chunking wholesale (the catalog is a *derived index*, not authored content — see [02-ai-brain §2.2](./02-ai-brain.md#22-chunking)). Until then, CSV re-import is the refresh path.

**One atomic chunk per product**, templated for commerce (structured beats prose for retrieval):

```
[Catalog • {name}] price: {price} {currency} · {availability} · {short_description} · {url}
```

> Catalog facts that *must* be live and exact (current stock, current price during a sale) are answered by **tools** (`check_inventory`, the commerce path) on the live turn, not from a possibly-stale chunk. The catalog chunk grounds *discovery* ("do you sell X?", "what's roughly the price range?"); tools ground *commitment*.

### (c) FAQ — Q/A pairs

- **One chunk per Q+A pair.** Never split an answer from its question (the chunking rule in [02-ai-brain §2.2](./02-ai-brain.md#22-chunking)). The question text dominates the embedding; the answer is the payload.
- **Suggested starters.** The dashboard seeds 6–10 high-value starter questions by vertical (e.g., "Do you ship internationally?", "What are your hours?", "How do I track my order?") so a non-technical owner isn't staring at a blank box.
- FAQ pairs are also the **landing format** for auto-extracted items from Website Scan and Learn-from-Conversations — they arrive as `draft` FAQ pairs the owner can edit and approve.

### (d) Policies — returns / shipping / warranty / privacy

- Free-form or pasted policy text per category, **split into section-level chunks** using the structure-aware recursive splitter (`#`/`##` → paragraph → sentence) from [02-ai-brain §2.2](./02-ai-brain.md#22-chunking).
- Each chunk is prefixed with `[Policy • {category}] > [{section}]` before embedding so a retrieved fragment carries its context.
- One `kb_document(type='policy')` per category; sections are its chunks.

### (e) Tone / Persona — NOT embedded; injected into the system prompt

Persona is **behavior**, not knowledge. Embedding it would pollute retrieval (a customer asking about returns would pull in "be cheerful" chunks).

- Stored as structured fields on `agent_config` (`tone`, `language`, `system_prompt` fragment) — see [04-data-model §3.4](./04-data-model.md#34-agent_config-agent--bot-configuration).
- Composed into the system prompt at turn assembly, **above** the RAG context block (see the prompt assembly in [02-ai-brain §3.2](./02-ai-brain.md#32-long-term-durable--summary)).
- Includes a hard **"never say" guardrail list** — phrases/claims the bot must never make (e.g., "we guarantee delivery by Friday", "this cures…", medical/legal/financial promises, competitor names, discount codes it wasn't given). These are injected as explicit negative constraints and double-checked at **GUARD-OUT** ([02-ai-brain §6](./02-ai-brain.md#6-guardrails-anti-hallucination--pii)).

```
SYSTEM PROMPT (assembled per turn)
  ├─ base instructions (grounded-answer-only, cite-or-refuse)
  ├─ TENANT PERSONA   ← tone, language, voice            (from agent_config)
  ├─ "NEVER SAY" LIST ← hard negative constraints        (from agent_config)   ← NOT embedded
  ├─ long-term summary
  ├─ RAG CONTEXT      ← retrieved tenant chunks (cited)   ← the embedded KB
  └─ user message
```

### (f) Website Scan / Sync — paste a domain, get a clean KB

The marquee auto-import. Turns a public site into structured, approved knowledge.

**Flow:** paste domain → choose scope → crawl → AI extracts into a clean schema → auto-convert to Q&A pairs / chunks → land as `draft` for review.

```
  owner pastes https://kareems.coffee
        │  scope:  ( ) single page     (•) scan priority pages
        ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │ DISCOVER   sitemap.xml + robots.txt → priority pages                 │
  │            (home, about, contact, products, pricing, faq, policies,  │
  │             shipping, returns, blog/announcements)                   │
  └───────────────┬─────────────────────────────────────────────────────┘
                  │  one queued sub-job per page (pgmq), ≤150s each
                  ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │ FETCH      HTTP GET → if JS-heavy / empty body → HEADLESS RENDER      │
  │            (Playwright/Browserless) → readable HTML/text              │
  └───────────────┬─────────────────────────────────────────────────────┘
                  ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │ EXTRACT    LLM extracts into a CLEAN SCHEMA, not raw dump:            │
  │            { contacts, hours, products[], prices[], policies[],       │
  │              announcements[], faq[] }                                 │
  └───────────────┬─────────────────────────────────────────────────────┘
                  ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │ CONVERT    schema → Q&A pairs / typed chunks                          │
  │            → kb_document rows with status = 'draft'                   │ ← REVIEW GATE (§3)
  └─────────────────────────────────────────────────────────────────────┘
```

- **Scope toggle:** *"Scan priority pages"* (sitemap + the curated priority-page list above) vs *"Single page"* (just the pasted URL). Default to priority pages on first connect.
- **Public URLs only.** No auth-walled pages, no admin panels; honor `robots.txt`. The crawler is read-only and identifies itself.
- **Headless render for JS-heavy sites.** If a plain fetch returns an empty/near-empty `<body>` (SPA), re-fetch through a headless browser so React/Vue/Shopify storefronts extract correctly.
- **AI *extracts*, it does not dump.** The crawled page is run through an extraction prompt that emits the typed schema above; we ingest the *clean* extraction (a price, a policy section, a contact), not the raw nav/footer/cookie-banner noise. Extracted facts auto-convert to Q&A pairs and policy/profile chunks.
- **Crawl runs as queued sub-jobs.** Because Supabase **Edge Functions cap at ~150s** (ADR-0002), a crawl is never one long function. The discover step enqueues **one `pgmq` sub-job per page**; each sub-job fetches + extracts within its own 150s budget; a coordinator marks the source `ready` when all sub-jobs finish. Long sites simply mean more sub-jobs, never a timeout.

### (g) File Upload — PDF / DOCX / TXT

- Upload → **Supabase Storage** (tenant-scoped bucket path `kb/{tenant_id}/{doc_id}/…`) → enqueue an `ingest` job → **same canonical pipeline** as everything else.
- Text extraction per type (PDF text layer / OCR fallback; DOCX via a parser; TXT as-is) → structure-aware chunking → embed → upsert.
- Files also land **review-gated** when large/auto-heavy; small owner-uploaded files can be auto-approved (owner's own deliberate action). The Storage object is retained for re-extraction on pipeline upgrades.

### (h) Learn-from-Conversations — mine resolved chats (Tidio pattern)

After a conversation is **resolved** (closed, or a positive resolution signal), a background job extracts candidate Q&A pairs from how the bot/agent actually answered.

- Candidates land as **`draft`/`disabled` FAQ pairs** — **disabled by default**, never auto-live. The owner reviews, edits, approves (or discards) in the FAQ tab.
- PII is scrubbed before extraction (the conversation may contain customer names, emails, order numbers — none of that becomes KB). Only the *general* question/answer shape is kept.
- This closes the loop: real customer questions the KB *couldn't* answer become draft KB entries the owner can promote — turning the refusal/handoff rate ([02-ai-brain §9](./02-ai-brain.md#per-turn-metrics-to-watch)) into KB growth.

---

## 3. The review / approve UX — the trust gate

This is the single mechanism that makes auto-import (Website Scan, File Upload, Learn-from-Conversations) safe to ship to non-technical owners.

> **Rule:** every **auto-extracted** item is created with `status = 'draft'` (synonym: pending/disabled). **Only `status = 'approved'` items are embedded into the retrievable index.** Drafts are *not* indexed and can *never* be retrieved on a live turn.

```
  auto-extracted item ──► kb_document.status = 'draft'   (NOT embedded, NOT retrievable)
                                   │
        owner reviews in dashboard │  edit · approve · discard
                                   ▼
        approved ──► ingest pipeline (§5) ──► kb_chunk (embedded, retrievable)
        discarded ─► soft-deleted; never indexed
        disabled ──► (previously approved) chunks tombstoned/removed; instantly off
```

- **Review queue UI:** a "Needs review (N)" badge per source; a side-by-side view of the extracted Q&A / chunk with its source URL or file; bulk **Approve all** / **Approve selected** / **Discard**.
- **Provenance shown:** every draft cites where it came from (`source_uri`, page title, "learned from a conversation on …") so the owner can sanity-check before approving.
- **Owner-authored items skip the gate.** A row the owner typed themselves (a manual FAQ, a Business Profile field) is implicitly trusted → `approved` on save. The gate exists specifically for *machine-extracted* content.
- **Disable is instant and reversible.** Toggling an approved item to `disabled` tombstones/removes its chunks immediately (next retrieval can't see it); re-enabling re-embeds. No re-crawl needed.

This mirrors Tidio Lyro's "pending review before active" and Intercom's draft→publish — and it is *why* a business will trust "scan my website" without fear of the bot suddenly quoting its own cookie banner.

---

## 4. Re-sync & freshness — why this is non-negotiable

A knowledge base is a **liability the moment it goes stale.** The worst failure mode of a support bot is confidently quoting a *wrong, outdated* fact — last month's price, a discontinued product, an expired promo. That is worse than "I don't know," because the customer acts on it.

**Two refresh triggers:**

1. **Scheduled re-crawl / re-pull per source** — `pg_cron` jobs run per `knowledge_source` on its own cadence (e.g., website daily, catalog hourly if Shopify-synced, policies weekly). Each fires the same crawl/extract pipeline as the initial scan.
2. **Manual "Re-sync now" button** — per source, in the Data Sources tab, for the owner who *just* changed a price and wants it live immediately.

**What re-sync actually does (diff, don't re-embed the world):**

```
  re-sync(source) ──► re-fetch ──► content_hash per doc
        │
        ├─ hash unchanged ──► skip  (no embed call, no cost)
        ├─ hash changed   ──► re-chunk → re-embed ONLY changed docs → upsert
        └─ doc gone       ──► tombstone its chunks (remove from index)
```

- **Diff by `content_hash`.** Only docs whose content actually changed are re-chunked and re-embedded. A daily crawl of a 200-page site that didn't change costs ~zero embeddings.
- **Re-extracted items re-enter the review gate** when the change is material (a new product, a changed policy) — *unless* the owner has opted a source into "auto-approve refreshes" for low-risk sources. Price-only deltas on already-approved catalog rows can update in place.
- **Stale announcements expire.** Time-boxed content (sales, holiday hours, "back in stock soon") carries an `expires_at`; an expiry sweep (`pg_cron`) disables expired chunks so the bot stops mentioning a sale that ended.

> **The non-negotiable, stated plainly:** *do not quote an old price.* Freshness machinery (scheduled re-crawl + manual re-sync + hash-diff + expiry) is the difference between a KB that builds trust and one that erodes it. Ship it with the crawl, not "later."

---

## 5. The ingest pipeline (reuse, don't reinvent)

**All eight sources (except Tone/Persona) converge on one pipeline.** Do not build per-source ingesters. The canonical path, owned in detail by [02-ai-brain §2.2–2.4](./02-ai-brain.md#22-chunking) and [04-data-model §3.5](./04-data-model.md#35-business_info-businessinfo-and-knowledge_doc--knowledge_chunk):

```
  approved kb_document(type, source_uri, content_hash)
        │
        ▼  enqueue 'ingest' on pgmq  { tenant_id, doc_id, type, source_uri, content_hash }
  ┌──────────────────────────────────────────────────────────────────────────┐
  │ INGEST WORKER  (Edge Function off pgmq, or Cloud Run Job for heavy files)  │
  │  (1) EXTRACT   type-specific text extraction (HTML/PDF/DOCX/row template)  │
  │  (2) CHUNK     structure-aware per §2.2  (1 chunk/FAQ pair, 1/product, …)  │
  │  (3) EMBED     LiteLLM  (tenant VIRTUAL KEY; embedding model PINNED per    │
  │                plan tier; IMMUTABLE per index)  → vector(1536), normalized │
  │  (4) UPSERT    Retriever.upsert(tenantId, chunks) → pgvector               │
  │                RLS-scoped; tenant_id RE-STAMPED server-side (not from job) │
  └──────────────────────────────────────────────────────────────────────────┘
        │
        ▼  knowledge_doc.status = 'ready'   ·   kb_chunk rows live & retrievable
```

Non-negotiables inherited from the AI-brain doc — restated because the KB is where they're *exercised*:

- **Embed via LiteLLM with the tenant's virtual key.** No direct provider calls. Cost is attributed per tenant (feeds the usage ledger — §10).
- **Embedding model is pinned per plan tier and immutable per index.** A tier change is a **full per-tenant re-embed** (`Retriever.reembed`), served from the old index until atomic cutover. The KB never silently mixes embedding models in one index. (See [02-ai-brain §2.3](./02-ai-brain.md#23-embeddings).)
- **`tenant_id` is re-stamped server-side on every upsert.** The ingest worker is a *less-trusted plane*; RLS backstops it but the Core API/worker re-validates and re-stamps `tenant_id` — it is **never** trusted from the job payload.
- **Catalog re-chunks wholesale on every sync** (derived index); FAQ/policy/profile re-embed per-doc on change (authored content, hash-diffed).
- **All vector access goes through the `Retriever` interface** — pgvector today, Qdrant swap-in later, KB code unchanged.

---

## 6. Data model

The KB **adds** `knowledge_source` and **extends** `knowledge_doc` (status workflow, source ref, freshness) on top of the base schema in [04-data-model §3.5](./04-data-model.md#35-business_info-businessinfo-and-knowledge_doc--knowledge_chunk). `kb_chunk` is the `knowledge_chunk` table from that doc (`vector(1536)`, HNSW, RLS + FORCE RLS, hash/list-partitioned by `tenant_id`). Structured Business Profile and Catalog fields live on dedicated tables. Every table carries the canonical RLS policy ([04-data-model §4](./04-data-model.md#4-the-canonical-rls-policy-applied-to-every-tenant-scoped-table)).

### 6.1 `knowledge_source` — one row per Data Source tab instance

```sql
CREATE TABLE knowledge_source (
  tenant_id        uuid NOT NULL REFERENCES tenant(tenant_id) ON DELETE CASCADE,
  source_id        uuid NOT NULL DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN
                     ('business_profile','catalog','faq','policy',
                      'website','file','conversation_learned')),
  -- persona/tone is NOT a knowledge_source (it lives on agent_config; never embedded).
  label            text,                         -- e.g. "kareems.coffee (website)"
  config           jsonb NOT NULL DEFAULT '{}',  -- {domain, scope:'priority|single', shopify_*, ...}
  is_enabled       boolean NOT NULL DEFAULT true, -- per-source toggle (dashboard)
  auto_approve_refresh boolean NOT NULL DEFAULT false, -- low-risk sources only
  sync_schedule    text,                         -- pg_cron expression; null = manual-only
  status           text NOT NULL DEFAULT 'idle'  -- idle|crawling|extracting|ingesting|ready|error
                     CHECK (status IN ('idle','crawling','extracting','ingesting','ready','error')),
  last_synced_at   timestamptz,
  next_sync_at     timestamptz,
  chunk_count      int  NOT NULL DEFAULT 0,       -- denormalized for the dashboard
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source_id)
);
CREATE INDEX idx_ksource_tenant ON knowledge_source (tenant_id, kind, is_enabled);
```

### 6.2 `kb_document` — extends `knowledge_doc` with the status workflow & freshness

```sql
-- The doc-level row (the base table is knowledge_doc, 04-data-model §3.5).
-- KB-specific columns the review gate + freshness machinery require:
ALTER TABLE knowledge_doc
  ADD COLUMN source_id   uuid,                    -- FK → knowledge_source (which tab produced it)
  ADD COLUMN type        text NOT NULL DEFAULT 'manual'   -- business_profile|catalog|faq|policy|website|file|conversation_learned
               CHECK (type IN ('business_profile','catalog','faq','policy',
                               'website','file','conversation_learned','manual')),
  ADD COLUMN status      text NOT NULL DEFAULT 'draft'    -- draft|approved|disabled|error
               CHECK (status IN ('draft','approved','disabled','error')),
  ADD COLUMN provenance  jsonb NOT NULL DEFAULT '{}',     -- {source_uri, page_title, learned_from_conv_id, ...}
  ADD COLUMN expires_at  timestamptz,            -- time-boxed announcements; null = permanent
  ADD COLUMN last_synced_at timestamptz,
  ADD CONSTRAINT fk_doc_source
      FOREIGN KEY (tenant_id, source_id) REFERENCES knowledge_source(tenant_id, source_id) ON DELETE CASCADE;

-- ONLY approved, enabled, unexpired docs are eligible to be embedded/retrieved.
CREATE INDEX idx_doc_retrievable ON knowledge_doc (tenant_id, status)
  WHERE status = 'approved';
```

> **The gate, enforced in data:** the ingest worker only ever embeds docs where `status='approved'`. A `draft` doc has **no `kb_chunk` rows**, so it is structurally unretrievable — the review gate is not a UI nicety, it's a pipeline precondition.

### 6.3 `kb_chunk` — the retrievable index (= `knowledge_chunk`)

Unchanged from [04-data-model §3.5](./04-data-model.md#35-business_info-businessinfo-and-knowledge_doc--knowledge_chunk). Recap of the load-bearing columns:

| Column | Type | Role |
|---|---|---|
| `tenant_id` | `uuid` | Isolation root; leads PK + every index; RLS + FORCE RLS. |
| `chunk_id` | `uuid` | PK (with `tenant_id`). |
| `doc_id` | `uuid` | FK → `knowledge_doc` (cascades on disable/delete). |
| `content` | `text` | Raw chunk text (for the prompt). |
| `embedding` | `vector(1536)` | Pinned dim; cosine HNSW; one model per index. |
| `metadata` | `jsonb` | `{title, section, url, kind}` — source markers for citation. |

### 6.4 Structured Business Profile & Catalog fields

```sql
-- Business Profile: structured columns (queryable, never hallucinated) on business_info
-- (extends 04-data-model §3.5). hours/payment are read DIRECTLY for "are you open?".
ALTER TABLE business_info
  ADD COLUMN socials         jsonb,        -- {instagram, x, tiktok, facebook}
  ADD COLUMN payment_options text[],       -- {visa, mastercard, applepay, cod, ...}
  ADD COLUMN timezone        text;         -- IANA tz; hours jsonb already present
  -- name/phone/email/address/website/hours already exist in business_info.

-- Catalog rows: structured product/service rows; one kb_chunk is derived per row.
CREATE TABLE catalog_item (
  tenant_id         uuid NOT NULL REFERENCES tenant(tenant_id) ON DELETE CASCADE,
  item_id           uuid NOT NULL DEFAULT gen_random_uuid(),
  source_id         uuid,                  -- FK → knowledge_source (manual|csv|shopify|woo)
  name              text NOT NULL,
  short_description text NOT NULL,
  price             numeric(14,2),
  currency          text DEFAULT 'USD',
  availability      text CHECK (availability IS NULL OR availability IN
                      ('in_stock','out_of_stock','preorder','discontinued')),
  url               text,
  external_ref      text,                  -- shopify/woo product id for sync diffing
  status            text NOT NULL DEFAULT 'approved'
                      CHECK (status IN ('draft','approved','disabled')),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, item_id),
  FOREIGN KEY (tenant_id, source_id) REFERENCES knowledge_source(tenant_id, source_id) ON DELETE SET NULL
);
CREATE INDEX idx_catalog_tenant ON catalog_item (tenant_id, status);
CREATE UNIQUE INDEX uq_catalog_external ON catalog_item (tenant_id, external_ref)
  WHERE external_ref IS NOT NULL;          -- idempotent Shopify/Woo upsert
```

**Status vocabulary (one model, used everywhere):**

| `status` | In the index? | Set by | Meaning |
|---|---|---|---|
| `draft` | ❌ no chunks | auto-extraction (crawl, file, conversation) | Awaiting owner review. |
| `approved` | ✅ embedded | owner approval, or owner-authored save | Live & retrievable. |
| `disabled` | ❌ chunks removed | owner toggle, expiry sweep | Was live; turned off instantly. |
| `error` | ❌ | pipeline failure | Shown in dashboard with `last_error`. |

---

## 7. Data Sources dashboard tab

One screen, one row per `knowledge_source`, built to be legible to a non-technical owner.

```
  ┌── Knowledge Base ▸ Data Sources ───────────────────────────────────────────────┐
  │  Source                Status     Last sync     Chunks   Enabled   Needs review  │
  │  ───────────────────────────────────────────────────────────────────────────── │
  │  Business Profile      ● Ready    2h ago          1        [on]         —    [Re-sync]│
  │  Catalog (CSV)         ● Ready    1d ago         142       [on]         —    [Re-sync]│
  │  FAQ                   ● Ready    just now         18       [on]         —    [Edit]   │
  │  Policies              ● Ready    3d ago           7        [on]         —    [Edit]   │
  │  kareems.coffee (web)  ● Ready    6h ago          63       [on]      (4)    [Re-sync]│
  │  warranty.pdf (file)   ◐ Ingesting  …             —        [on]         —          │
  │  Learned from chats    ● Ready    1h ago          —        [on]      (9)    [Review] │
  │  Shopify (roadmap)     ○ Not connected  —          —        [—]         —    [Connect]│
  │  ───────────────────────────────────────────────────────────────────────────── │
  │  Tone / Persona  →  configured in Agent settings (not a retrievable source)      │
  └──────────────────────────────────────────────────────────────────────────────────┘
```

Per-source row exposes:

- **Status** — `idle / crawling / extracting / ingesting / ready / error` (with the error message inline on failure).
- **Last sync** — `last_synced_at`, relative; **Next sync** on hover for scheduled sources.
- **Chunk count** — `chunk_count` (the size of this source's contribution to the index).
- **Enable / disable toggle** — flips `is_enabled`; disabling removes the source's chunks from retrieval instantly.
- **Needs review (N)** — count of `draft` docs from this source; links to the review queue (§3).
- **Errors** — last error surfaced with a retry action.
- **"Re-sync now"** — manual trigger of the §4 pipeline for that source.

---

## 8. Supabase specifics

Mapping the KB onto the Supabase primitives chosen in [ADR-0002](./ADR-0002-supabase-backend.md):

| KB concern | Supabase primitive | Notes |
|---|---|---|
| Uploaded files (PDF/DOCX/TXT) | **Supabase Storage** | Tenant-scoped bucket path `kb/{tenant_id}/{doc_id}/…`; RLS/storage policies scope access; object retained for re-extraction. |
| Crawl / ingest / re-sync queues | **`pgmq`** | `ingest`, `crawl` (sub-jobs), `reembed`, `conversation_mine` queues. No separate Redis to run. |
| Scheduled re-crawl & expiry sweep | **`pg_cron`** | Per-source `sync_schedule`; invokes Edge Functions via `pg_net`. 1–59s granularity. |
| Crawl sub-jobs / extraction / ingest | **Edge Functions (Deno)** | **~150s cap** → crawls are **chunked into queued sub-jobs**, one per page; heavy file extraction can fall back to a Cloud Run Job. |
| Vector index | **pgvector** | `kb_chunk.embedding vector(1536)`, HNSW cosine, behind the `Retriever` interface. |
| Tenant isolation | **RLS + FORCE RLS** | Every KB table; client (Flutter) reads auto-scoped by the JWT `tenant_id` claim; workers use `SET LOCAL app.tenant_id`. |

> ### ⚠️ Load-bearing warning: `service_role` bypasses RLS
>
> Supabase's **`service_role` key bypasses Row-Level Security entirely** — the exact footgun that disqualified the Firebase-native design (ADR-0001/0002). Every KB **ingest writer** (the crawl sub-jobs, the file ingest function, the conversation-miner, any re-embed job) is a *less-trusted plane*. Therefore:
>
> - Ingest writers run as a **dedicated non-superuser, `NOBYPASSRLS` Postgres role** with RLS enforced — **not** as `service_role`. `service_role` is reserved for narrow, audited admin/migration tasks only.
> - Every ingest write **re-validates and re-stamps `tenant_id` server-side** — never trusts the `tenant_id` in its own job payload.
> - The **"zero rows without tenant context"** CI invariant ([04-data-model §4](./04-data-model.md#4-the-canonical-rls-policy-applied-to-every-tenant-scoped-table)) covers `kb_chunk`, `knowledge_doc`, `knowledge_source`, and `catalog_item`.
> - Connection pooling via **Supavisor in transaction mode**, so `SET LOCAL app.tenant_id` cannot leak across pooled connections.

---

## 9. The website is BOTH a channel AND a KB source — keep them separate

A common conflation. The same business website plays **two unrelated roles**, with different code paths, different data, and different lifecycles:

| | **Website as a CHANNEL** (chat widget) | **Website as a KB SOURCE** (crawl) |
|---|---|---|
| What it is | The embeddable chat widget the business puts on its site | The business's public pages, crawled for content |
| Direction | **Inbound** customer messages → the agent answers | **Ingest** of the site's own content → the index |
| Lives in | `channel_connection` (`channel_type='web'`, publishable/secret keys) — see [01-channels.md](./01-channels.md) | `knowledge_source` (`kind='website'`) — this doc §2(f) |
| Identity | Publishable key / HMAC visitor identity | A domain string + crawl scope |
| Lifecycle | Connect once; serves live turns | Crawl + re-sync on a schedule |
| Failure mode | Widget down → no inbound web chats | Crawl stale → bot quotes old facts |

> **One sentence:** the **widget** is *how customers talk to the bot*; the **crawl** is *part of what the bot knows*. Connecting the widget does **not** ingest the site, and crawling the site does **not** install a widget. They are configured on different screens and are independently enable/disable-able.

---

## 10. Cost / metering note

Embeddings are **metered against the plan** like every other LLM cost (the usage ledger is the source of truth — [02-ai-brain §8](./02-ai-brain.md#8-cost-discipline-baked-into-the-brain), [04-data-model §3.8](./04-data-model.md#38-usage_ledger-usagemeter--source-of-truth-and-usage_rollup)). KB-specific cost shape:

- **Embedding tokens flow through LiteLLM with the tenant's virtual key** → tagged to the tenant → appended to `usage_ledger` (`meter='ai_tokens'`). No direct provider calls, no untracked spend.
- **Big catalogs cost more.** A 5,000-SKU catalog is 5,000 chunks to embed; a 200-page site is dozens-to-hundreds of chunks. Initial ingest of a large source is a visible, one-time embedding spend.
- **Re-sync cost is bounded by the diff, not the size.** Because we hash-diff (§4), a daily re-crawl of an unchanged 200-page site costs **~zero** embeddings. Only changed docs re-embed. This is *why* freshness is affordable.
- **A tier upgrade = a full re-embed.** Switching embedding model (immutable per index) re-embeds the entire tenant KB once — a known, metered cost to surface in the plan-change UX, not a surprise.
- **Surface it in the dashboard.** Show estimated embedding cost on big imports ("Importing 5,000 products ≈ N tokens") so an owner isn't surprised, and so big-catalog tenants land on the right plan.

---

## 11. Definition of done (Knowledge Base)

- [ ] Eight Data Source tabs render; Tone/Persona is on Agent settings and is **never embedded**.
- [ ] All sources (except persona) flow through **one** canonical ingest pipeline (`kb_document(type) → chunk → embed via LiteLLM → pgvector upsert, tenant_id re-stamped`).
- [ ] Business Profile stores structured columns + one synthesized chunk + `hours`/`tz` metadata; **"are you open?" answered with no LLM call**.
- [ ] Catalog: manual rows + CSV import live; one atomic chunk per product; Shopify/Woo sync stubbed behind `external_ref` for the roadmap.
- [ ] FAQ = one chunk per Q+A pair; suggested starters seeded.
- [ ] Policies section-split with `[Policy • category] > [section]` prefixing.
- [ ] Website Scan: scope toggle (priority vs single), public-URLs-only + `robots.txt`, headless render fallback, **crawl as `pgmq` sub-jobs ≤150s each**, AI **extracts** into a clean schema → Q&A/chunks.
- [ ] File Upload → Supabase Storage → same pipeline.
- [ ] Learn-from-Conversations lands candidate Q&A as **`draft`/disabled-by-default** with PII scrubbed.
- [ ] **Review gate enforced in the pipeline:** only `status='approved'` docs are embedded; `draft` docs have zero `kb_chunk` rows.
- [ ] Re-sync: `pg_cron` per-source schedule + manual "Re-sync now"; hash-diff re-embeds only changed docs; `expires_at` sweep disables stale announcements.
- [ ] Data model: `knowledge_source`, extended `knowledge_doc` (status/source_id/provenance/expires_at), `catalog_item`, Business Profile structured columns — all RLS + FORCE RLS, `tenant_id`-led.
- [ ] Data Sources dashboard: per-source status, last sync, chunk count, enable/disable, needs-review count, errors, "Re-sync now".
- [ ] Ingest writers run as a non-`service_role` RLS role; `tenant_id` re-stamped on every write; "zero rows without tenant context" CI test covers all KB tables.
- [ ] Website-as-channel vs website-as-source documented and implemented as separate, independently-toggleable features.
- [ ] Embedding spend metered to `usage_ledger`; big-import cost estimate surfaced; tier-change re-embed cost surfaced.

---

*This document is authoritative for the Knowledge Base module and is consistent with the winning architecture as amended by ADR-0002 (Supabase). RAG mechanics, the model gateway, and guardrails are specified in [02-ai-brain.md](./02-ai-brain.md); the base schema and service decomposition in [04-data-model.md](./04-data-model.md); channel integrations (including the web widget) in [01-channels.md](./01-channels.md).*
