# Assisty — Research Brief

# Assisty — Research Brief (Ground Truth for Design & Copy)

A multi-tenant AI customer-service SaaS where each business connects its own messaging channels. This brief consolidates competitive, platform, architecture, security, and billing research into decisions downstream teams can build on. The backend platform decision is recorded in **ADR-0002** (`docs/ADR-0002-supabase-backend.md`).

## The n8n verdict (settled)
**Do NOT use n8n as Assisty's runtime "brain."** Two independent domains agree:
- **Competitive:** No major competitor runs n8n as its internal orchestration engine. It appears only as an *external* customer-facing integration (Respond.io officially lists it; ManyChat connects via webhooks in third-party tutorials). Chatfuel's real engine is a **custom cascade of Llama-405B models on Nebius** (beat GPT-4o by 24% on routing, cheaper) — LLM-native routing, not a workflow engine.
- **Architecture:** n8n's AI Agent node makes 2–4 LLM calls/query, RAG adds 200–500ms, with **16s+ production response times** reported; memory nodes don't isolate per-tenant; concurrency is fixed at startup. It is an **anti-pattern for always-on per-tenant chat**, but the *right* tool for ingestion pipelines, re-embedding, and internal ops. Expose n8n/Make/Zapier as **outbound integrations only**.

## Recommended stack leanings
- **Brain (live turn):** Custom stateless request/response service (NestJS or Python) on **Cloud Run / Fly.io / Railway** — a long-lived Node process, NOT a Supabase Edge Function (Deno, 150s-capped, reserved for light async/ingest tasks). Add **LangGraph** only when cyclic multi-tool reasoning is needed; **Temporal** only for long-running async (human handoff spanning hours), else **Supabase Queues (pgmq) + pg_cron** (Upstash Redis + BullMQ kept on file as the alternative if richer queue semantics are needed).
- **Model gateway:** **LiteLLM Proxy** (Teams + Virtual Keys are open-source). Per-tenant virtual keys give revocable, budgeted, model-restricted access (tenant picks GPT vs Gemini) + automatic fallbacks on 429/500/timeout.
- **Vector store:** **pgvector + RLS** inside **Supabase Postgres** (pgvector built-in), every index led by `tenant_id`. (Qdrant with indexed `tenant_id` payload filtered inside HNSW, or **Pinecone** namespace-per-tenant, remain options if a dedicated vector engine is later needed — watch the per-index namespace cap.) Embedding model is **immutable per index** — switching = full re-embed; pin per tenant tier.
- **Embeddings:** Default OpenAI `text-embedding-3-small` (1536d, $0.02/1M); quality tier `gemini-embedding-001` (truncatable to 1536). Both support Matryoshka truncation to cut storage.
- **App:** Flutter + **Riverpod 2** (over Bloc), GoRouter, Dio, Drift offline cache, FCM push.
- **Backend store:** **Supabase Postgres** as system of record — NOT Firestore as primary. Domain is relational + metering-heavy; Firestore's per-op pricing is unpredictable at messaging scale and locks in. Use **Supabase Auth** (JWT) for identity — RLS policies read the tenant from a custom JWT claim (`auth.jwt() ->> 'tenant_id'`) — plus **Supabase Storage** for uploaded KB files and FCM for push. See **ADR-0002**.
- **Realtime:** REST + FCM data messages default; **Supabase Realtime (Postgres CDC over WebSocket)** for live dashboards, with **SSE** kept as a fallback (Cloud Run WS is capped 60min, default 5min).

## WhatsApp / channels (hard facts)
- **Cloud API only** — On-Premises API EOL Oct 23, 2025. Register as a **Meta Tech Provider** (not BSP) so each tenant attaches their own payment method → **zero markup**; you bill software only.
- **Onboarding = Embedded Signup** (FB.login with `config_id`, `response_type:'code'`, `solutionID`). Returns `code` + `WA_EMBEDDED_SIGNUP` payload (`waba_id`, `phone_number_id`). Backend exchanges code → **Business Integration System User token** (effectively non-expiring), stored **encrypted, one per tenant**.
- **Two mandatory post-onboarding calls:** `POST /{waba_id}/subscribed_apps` (skip = no inbound webhooks, the #1 multi-tenant failure; no longer auto-created since late 2025) and `POST /{phone_number_id}/register` with 6-digit PIN.
- **One shared webhook URL** for all tenants; route by `phone_number_id`/`waba_id` from payload. Verify `X-Hub-Signature-256`, return 200 fast, process async (enqueue to **Supabase Queues / pgmq**), dedupe on `wamid` via a Postgres **unique constraint** (e.g. unique `wamid`) plus an idempotency table — not a Redis `SETNX`.
- **Pricing:** per-message since Jul 1, 2025. Service (free-form, in 24h window) free; **Utility free inside the open 24h window**; Marketing/Auth always paid. Hidden Meta per-message fees can make real cost 2–5× sticker — pricing copy must be transparent.
- **Tiers:** 250 (unverified) → 1k → 10k → 100k → unlimited unique customers/24h; throughput ~80 msg/s default (up to 1,000). Portfolio-based since Oct 2025.

## Other channels — feasibility
- **Instagram DM + Messenger:** Feasible together (shared Graph API, same 24h window + webhook/Send model). Gated by **Meta App Review + Business Verification** (slow, weeks-to-months). Past 24h: human-agent tag is **humans only** (no bot automation). Legacy message tags die Apr 27, 2026.
- **Web widget + Email:** Fully feasible, fully under our control. Widget = JS loader → isolated iframe, publishable key client-side + secret key server-side, WebSocket/SSE + REST fallback, HMAC identity verification (Chatwoot is the reference). Email via provider inbound webhooks (Mailgun Routes / SendGrid Inbound Parse), thread by Message-ID/References, set SPF/DKIM/DMARC.
- **TikTok — NOT feasible:** No open API; partner-gated AND **geo-blocked for US/EEA/UK/CH** businesses, in Beta. **Do not promise TikTok DM automation** to those markets. Treat as out of scope / partner-mediated.

## Security baseline (P0, non-negotiable)
- **Tenancy:** Pooled shared DB with hard logical isolation, leaning **Bridge** (silo the encryption-key boundary). Postgres **RLS + FORCE ROW LEVEL SECURITY**, app role is non-owner/non-superuser/no-BYPASSRLS, `SET LOCAL app.tenant_id` per transaction (never plain `SET` — leaks across pooled connections), the async writer must re-stamp `app.tenant_id` on every transaction, every index led by `tenant_id`. Firestore rules are bypassed by Admin SDK — server must re-enforce scoping. **Supabase `service_role` bypasses RLS (the same flaw that disqualified Firebase) — the edge and AI worker MUST use a dedicated tenant-scoped non-superuser role with RLS enforced and `SET LOCAL app.tenant_id` per transaction, NEVER `service_role` for tenant data. Use Supabase's pooler (Supavisor) in transaction mode.** Invariant test: **zero rows readable without tenant context**.
- **Token encryption:** Two-layer model — **Supabase Vault (pgsodium AEAD, per-DB root key)** at rest, **PLUS an app-level per-tenant AES-256-GCM layer** so the per-tenant key can be deleted for **crypto-shredding** (GDPR erasure); store only ciphertext + wrapped per-tenant key.
- **Tool-calling:** Always inject `tenant_id` server-side from the authenticated session — **never** trust the model to supply it (top cross-tenant leak vector).
- **Webhooks:** HMAC-SHA256 over raw body, constant-time compare, 5-min timestamp tolerance, dedupe by event ID.
- **Other P0:** secrets in **Supabase Vault** + least-privilege roles; tamper-evident hash-chained append-only audit logs (never log tokens/PII); documented GDPR 1-month erasure path. **P1:** token-bucket rate limiting (tenant + user + endpoint), DPA + sub-processor list.

## Billing (the strategic win)
- Assisty qualifies for Google Play's **cloud-business-software + consumed-outside-the-app exemptions** → bill businesses **directly via Stripe with NO Google service fee**. Keep all purchase flows out of the Android binary (link to web). Verify classification in Play Console pre-launch.
- **Stripe Billing** directly (not RevenueCat — that's for consumer IAP). Use **Billing Meters API** (legacy usage records deprecated) for `messages_sent` / `ai_tokens`. Keep an **internal usage ledger as source of truth** for hard-cap enforcement; Stripe meters are for invoicing only.

## Competitive positioning & disagreements
- **Hybrid is the sweet spot:** LLM-native agent as default surface + visual flow builder for deterministic commerce flows (Chatfuel/Botpress pattern). Pure-flow feels dated; pure-LLM lacks commerce guardrails.
- **Pricing models vary:** flat ($69 Chatfuel), contact-based (ManyChat), per-resolution ($0.99 Intercom Fin, no caps — runaway-bill risk), per-conversation (~$0.58 Tidio Lyro), credits (Voiceflow/Botpress). **Differentiate on transparency + spend caps**; bundle AI in base (avoid ManyChat's $29 add-on).
- **Model stance:** Lead with a clear, benchmark-backed model claim (Intercom Fin Apex 73.1% resolution; Tidio markets "powered by Claude") — Chatfuel never names its model. **Avoid a thin GPT-wrapper at markup** (low moat); don't mark up pass-through API costs (Botpress sells this).
- **Channel table stakes:** WhatsApp + Instagram + Messenger + web widget.

**Noted tension:** The competitive domain frames Chatfuel's Llama-405B cascade as the *winning* architecture to emulate, while the architecture domain prescribes a custom-API + LiteLLM + Qdrant stack — these are compatible (both reject n8n-as-brain, both favor proprietary LLM-native routing), but Assisty does not need to self-host frontier-scale models early; LiteLLM over hosted providers achieves the same "custom routing layer" goal with far less ops cost.
