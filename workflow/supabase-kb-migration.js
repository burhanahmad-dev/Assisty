export const meta = {
  name: 'assisty-supabase-kb',
  description: 'Author the first-class Knowledge Base module doc + migrate all Assisty docs from GCP/Firebase infra to Supabase (per ADR-0002)',
  phases: [
    { title: 'Knowledge Base', detail: 'author docs/08-knowledge-base.md (Tidio-style Data Sources module)' },
    { title: 'Migrate', detail: 'surgically swap GCP/Firebase infra -> Supabase across every existing doc' },
  ],
}

const DOC_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    filename: { type: 'string' },
    markdown: { type: 'string' },
  },
  required: ['title', 'filename', 'markdown'],
  additionalProperties: false,
}

const EDIT_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    couldEditInPlace: { type: 'boolean' },
    editsApplied: { type: 'number' },
    remainingStaleRefs: { type: 'number' },
    changes: { type: 'array', items: { type: 'string' } },
    markdown: { type: 'string', description: 'ONLY if couldEditInPlace is false: the COMPLETE updated document, ready to overwrite the file.' },
  },
  required: ['file', 'couldEditInPlace', 'editsApplied', 'changes'],
  additionalProperties: false,
}

const MIGRATION_SPEC = `AUTHORITATIVE SUPABASE MAPPING (from ADR-0002). Apply these swaps; KEEP everything else verbatim.
SWAP:
- "Cloud SQL Postgres" / "Cloud SQL" (as the database)  ->  "Supabase Postgres" (same engine, pgvector built-in).
- "Firebase Auth"  ->  "Supabase Auth" (JWT; RLS policies read the tenant from a custom JWT claim auth.jwt() ->> 'tenant_id').
- "Cloud KMS" / "envelope encryption (per-tenant DEK/KEK)"  ->  "Supabase Vault (pgsodium AEAD, per-DB root key) PLUS an app-level per-tenant AES-256-GCM layer for crypto-shred". Keep the crypto-shred / GDPR-erasure concept (delete the per-tenant app key).
- "Memorystore Redis" + "BullMQ"  ->  "Supabase Queues (pgmq) + pg_cron" for async work (ingest, reembed, re-sync crawl, outbound-send, billing-meter). Note in passing that "Upstash Redis + BullMQ" is the kept-on-file alternative if richer queue semantics are needed.
- Redis "SETNX" idempotency / dedupe  ->  Postgres unique constraint (e.g. unique wamid) + an idempotency table.
- "Cloud Storage"  ->  "Supabase Storage" (uploaded KB files).
- "SSE" for the live dashboard  ->  "Supabase Realtime (Postgres CDC over WebSocket)"; keep SSE only as a fallback mention.
- Scheduled jobs / Cloud Scheduler  ->  "pg_cron" (powers Knowledge Base website re-sync).
KEEP (do NOT change):
- The architecture SHAPE: stateless edge -> durable queue -> stateless AI worker -> single Postgres+pgvector under RLS -> LiteLLM. Priorities, the n8n verdict, RAG design, spend-cap usage-ledger, Stripe billing, Meta Tech Provider / Google Play strategy, Flutter + Riverpod app, FCM push.
- "RLS", "FORCE ROW LEVEL SECURITY", "SET LOCAL app.tenant_id", tenant-led indexes, the async-writer re-stamp rule, the "zero rows without tenant context" invariant test — ALL stay.
- Firestore stays REJECTED (do not claim Assisty uses it); just ensure the system of record reads as "Supabase Postgres".
- "Cloud Run" as the COMPUTE host for NestJS stays, but phrase it as "Cloud Run / Fly.io / Railway" — the synchronous edge and AI worker are a long-lived Node process, NOT Supabase Edge Functions (which are Deno, 150s-capped and only for light async/ingest tasks). Do not delete the custom compute layer.
- "LiteLLM Proxy" / per-tenant virtual keys / GPT-vs-Gemini selection stays.
ADD where relevant (especially in security/data-model/role/connection sections):
- The load-bearing warning: "Supabase service_role bypasses RLS (the same flaw that disqualified Firebase) — the edge and AI worker MUST use a dedicated tenant-scoped non-superuser role with RLS enforced and SET LOCAL app.tenant_id per transaction, NEVER service_role for tenant data. Use Supabase's pooler (Supavisor) in transaction mode."
- A one-line pointer that the backend platform decision is ADR-0002 (docs/ADR-0002-supabase-backend.md).`

// ---------------- run ----------------
const KB_FOCUS = `Author docs/08-knowledge-base.md — the first-class "Knowledge Base" module for Assisty, modeled on how Tidio Lyro ("Data Sources" tab), Intercom Fin ("Knowledge Hub" + Website Sync), and Chatfuel (structured About Company / Catalog / FAQ) actually let businesses train their bots. CRITICAL FRAMING: this is RAG over a multi-source knowledge base, NOT model fine-tuning.
Required sections:
1. Purpose & mental model — the KB is the agent's "brain"; a multi-source hub; powered by RAG (retrieval), never fine-tuning. A short comparison table vs Chatfuel / Intercom Fin / Tidio Lyro.
2. The Data Sources (each a tab in the dashboard), specced concretely:
   (a) Business Profile — STRUCTURED fields: business name, contact (phone/email/address/socials), hours + timezone, payment options, website URL. Stored as structured columns AND a small synthesized chunk; hours also as structured metadata so "are you open?" needs no LLM call.
   (b) Catalog — products/services: name, price, availability, short description, url. Manual rows + CSV import + (roadmap) live Shopify/WooCommerce sync. One atomic chunk per product.
   (c) FAQ — Q/A pairs (one chunk per pair); suggested starters.
   (d) Policies — returns/shipping/warranty/privacy (section-split chunks).
   (e) Tone/persona — NOT embedded; injected into the system prompt; includes a "never say" guardrail list.
   (f) Website Scan/Sync — paste domain -> crawl (sitemap + priority pages; "scan priority pages" vs "single page") -> AI EXTRACTS into a clean schema (contacts, products, prices, policies, announcements, FAQ) -> auto-converted to Q&A pairs/chunks. Public URLs only. Headless render for JS-heavy sites. Crawl runs as queued sub-jobs (pgmq + Edge Functions, 150s cap each).
   (g) File Upload — PDF/DOCX/TXT -> Supabase Storage -> same ingest pipeline.
   (h) Learn-from-Conversations — after a resolved chat, extract candidate Q&A; land them DISABLED-by-default for owner review (Tidio pattern).
3. The review/approve UX — every auto-extracted item lands as status=draft/disabled; only APPROVED items become retrievable. This is what makes auto-import trustworthy.
4. Re-sync & freshness — pg_cron scheduled re-crawl per source + a manual "Re-sync now" button; diff & re-embed only changed docs; stale announcements expire. Explain why this is non-negotiable (don't quote an old price).
5. The ingest pipeline (reuse, don't reinvent) — canonical kb_document(type) -> chunk -> embed via LiteLLM (tenant virtual key, embedding model pinned per plan tier, immutable per index) -> pgvector upsert, RLS-scoped, tenant_id re-stamped server-side.
6. Data model — knowledge_source, kb_document, kb_chunk tables (with status: draft/approved/disabled, source ref, last_synced_at), plus the structured profile/catalog fields on tenant_config. Show columns.
7. Data Sources dashboard tab — per-source status, last sync, chunk count, enable/disable toggle, errors, "re-sync now".
8. Supabase specifics — Storage for files, pgmq + pg_cron for crawl/ingest/re-sync, Edge Functions for crawl sub-jobs, pgvector for chunks, RLS scoping, and the service_role-bypasses-RLS warning for any ingest writer.
9. Note that the website is BOTH a channel (chat widget) AND a KB source (crawl) — clarify the distinction.
10. Cost/metering note — embeddings metered against the plan; big catalogs cost more.
Write polished, opinionated, production-grade Markdown with tables and an ASCII flow diagram. filename MUST be exactly "docs/08-knowledge-base.md", title "Assisty — Knowledge Base & Data Sources".`

const DOC_TARGETS = [
  { key: 'architecture', path: 'D:\\Assisty\\ARCHITECTURE.md', extra: 'Also: update the header "Architecture:" line and the component table/diagram to Supabase; add a short note near the top linking to ADR-0002 (backend platform) and a mention of the new docs/08-knowledge-base.md in the "How the docs fit together" section.' },
  { key: 'research-brief', path: 'D:\\Assisty\\docs\\00-research-brief.md', extra: 'Update the "Recommended stack leanings" and "Backend store" lines to Supabase.' },
  { key: 'channels', path: 'D:\\Assisty\\docs\\01-channels.md', extra: 'Light touch — only infra references.' },
  { key: 'ai-brain', path: 'D:\\Assisty\\docs\\02-ai-brain.md', extra: 'Update vector-store/queue/host references; keep the n8n verdict and RAG design intact.' },
  { key: 'security', path: 'D:\\Assisty\\docs\\03-security.md', extra: 'IMPORTANT: add the service_role-bypasses-RLS warning prominently; swap Cloud KMS -> Supabase Vault + app-level per-tenant AES; keep all RLS/SET LOCAL/audit content.' },
  { key: 'data-model', path: 'D:\\Assisty\\docs\\04-data-model.md', extra: 'IMPORTANT: this has the most infra refs. Swap datastore/queue/auth references to Supabase; add the service_role warning to the roles/connection section; keep the schema and RLS content.' },
  { key: 'onboarding-billing', path: 'D:\\Assisty\\docs\\05-onboarding-billing.md', extra: 'Swap infra refs; the ingest pipeline now uses pgmq + pg_cron + Supabase Storage for uploads.' },
  { key: 'roadmap', path: 'D:\\Assisty\\docs\\06-roadmap.md', extra: 'IMPORTANT: 48 infra refs — update the consolidated tech stack, repo structure, infra/hosting, and cost model to the Supabase stack throughout.' },
  { key: 'adr-0001', path: 'D:\\Assisty\\docs\\ADR-0001-architecture-choice.md', extra: 'Add a top note: "Infrastructure choices in this ADR are superseded by ADR-0002 (Supabase backend); the architecture SHAPE is unchanged." Light infra-term updates only.' },
  { key: 'review', path: 'D:\\Assisty\\docs\\07-review-gaps-risks.md', extra: 'Update terminology only (e.g. "single Cloud SQL instance" -> "single Supabase Postgres instance"); the risk substance (single region, noisy neighbor, token custody) still applies.' },
]

const editorPrompt = (t) => `You are migrating ONE Assisty architecture doc to the Supabase backend. Make SURGICAL, in-place edits using the Read + Edit tools (Read the file first, then Edit). Preserve all non-infra content, structure, headings, tables, and code blocks verbatim.
TARGET FILE: ${t.path}
${MIGRATION_SPEC}
DOC-SPECIFIC: ${t.extra}
Prefer in-place Edit calls (set couldEditInPlace=true). Only if you genuinely cannot use Edit, set couldEditInPlace=false and return the COMPLETE updated document in 'markdown'. Report editsApplied, remainingStaleRefs (count of any GCP/Firebase infra terms you intentionally left, e.g. legitimate Cloud Run host mentions), and a short list of changes.`

phase('Knowledge Base')
phase('Migrate')

const tasks = []
tasks.push(() => agent(KB_FOCUS, { label: 'author:knowledge-base', phase: 'Knowledge Base', schema: DOC_SCHEMA }))
for (const t of DOC_TARGETS) {
  tasks.push(() => agent(editorPrompt(t), { label: `migrate:${t.key}`, phase: 'Migrate', schema: EDIT_SCHEMA }))
}

const results = await parallel(tasks)
const kb = results[0]
const edits = results.slice(1).filter(Boolean)

return {
  kb: kb ? { title: kb.title, filename: kb.filename, markdown: kb.markdown } : null,
  edits: edits.map(e => ({ file: e.file, couldEditInPlace: e.couldEditInPlace, editsApplied: e.editsApplied, remainingStaleRefs: e.remainingStaleRefs, changes: e.changes, markdown: e.couldEditInPlace ? undefined : e.markdown })),
}
