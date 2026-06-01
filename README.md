# Assisty

**AI-automated customer-service SaaS** — a Flutter app where a business connects its messaging channels (WhatsApp, Website, Email, Facebook Messenger, Instagram), fills a Knowledge Base, and Assisty's AI answers their customers automatically, grounded in that business's own data, with per-tenant privacy and hard spend caps.

> **Status:** Architecture/blueprint complete ✅ · Code not started yet ⬜
> **Backend:** Supabase (Postgres + pgvector + RLS + Auth + Storage + Queues/pgmq + Vault) · **Compute:** NestJS on Cloud Run/Fly · **AI:** LiteLLM gateway (GPT / Gemini) · **App:** Flutter + Riverpod 2

---

## 📖 Documentation — read in this order

| # | Document | What it covers |
|---|---|---|
| ▶ | [ARCHITECTURE.md](./ARCHITECTURE.md) | **Start here.** The whole system: component diagram, end-to-end request lifecycle, why this design won, glossary. |
| 00 | [docs/00-research-brief.md](./docs/00-research-brief.md) | Ground-truth research: competitors, WhatsApp facts, the n8n verdict, stack leanings. |
| 01 | [docs/01-channels.md](./docs/01-channels.md) | WhatsApp / Messenger / Instagram / Web widget / Email integration; the channel adapter; feasibility table. |
| 02 | [docs/02-ai-brain.md](./docs/02-ai-brain.md) | AI core: RAG, memory, model routing (GPT/Gemini), tools, guardrails, **the n8n decision**. |
| 03 | [docs/03-security.md](./docs/03-security.md) | Multi-tenant isolation, RLS, token encryption (Vault), `service_role` warning, GDPR. |
| 04 | [docs/04-data-model.md](./docs/04-data-model.md) | Database schema, tables, `usage_ledger`, pgvector, backend services. |
| 05 | [docs/05-onboarding-billing.md](./docs/05-onboarding-billing.md) | Auth, the "activate agent" onboarding flow, subscriptions & quotas. |
| 06 | [docs/06-roadmap.md](./docs/06-roadmap.md) | Final tech stack, repo structure, phased roadmap, cost model. |
| 07 | [docs/07-review-gaps-risks.md](./docs/07-review-gaps-risks.md) | Honest critic pass: gaps, contradictions, risks, open decisions. |
| 08 | [docs/08-knowledge-base.md](./docs/08-knowledge-base.md) | **Knowledge Base / Data Sources** module: structured fields + website scan + uploads + learn-from-chats + re-sync. |

### Decision records (ADRs)
- [ADR-0001 — Architecture choice](./docs/ADR-0001-architecture-choice.md) — why Custom Cloud-Native won the 3-way bake-off.
- [ADR-0002 — Supabase backend](./docs/ADR-0002-supabase-backend.md) — the GCP→Supabase mapping + the `service_role`/RLS warning.
- [ADR-0003 — Product & scope decisions](./docs/ADR-0003-product-decisions.md) — channels, models, markets, billing, deferrals.

---

## 🗂️ Planned repo structure

```
Assisty/
├── README.md            ← you are here
├── docs/                ← architecture docs + ADRs (complete)
├── app/                 ← Flutter app (Riverpod 2, GoRouter, supabase_flutter, FCM)   [not started]
├── backend/             ← NestJS edge + AI worker, LiteLLM config                      [not started]
├── supabase/            ← SQL migrations: tables + RLS + pgvector + pgmq + pg_cron      [not started]
└── workflow/            ← internal doc-generation scripts (not part of the product)
```

## 🚦 Roadmap (high level)
- **Phase 0** — Supabase schema + RLS, auth, tenant bootstrap, Flutter dashboard shell
- **Phase 1** — WhatsApp end-to-end (inbound → AI → reply)
- **Phase 2** — AI brain + RAG + Knowledge Base module
- **Phase 3** — Billing / subscriptions / free tier
- **Phase 4** — More channels (Messenger, Instagram)
- **Phase 5** — Analytics, human handoff, scale

## 📌 MVP scope at a glance
- **Channels:** WhatsApp + Web + Email (live), Messenger + Instagram (after Meta approval), TikTok (waitlist — no API yet)
- **Models:** GPT + Gemini + free models (Anthropic addable later)
- **Markets:** US + Pakistan + global, except Israel
- **Deferred:** live Shopify sync, agency mode

---

## Local development

The backend is a NestJS monolith on Postgres (pgvector) with a LiteLLM gateway,
all wired up via Docker Compose.

```bash
# 1. Configure env (no real secrets in the example)
cp .env.example .env
# edit .env: set OPENAI_API_KEY, LITELLM_MASTER_KEY (= LITELLM_API_KEY),
#            WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET

# 2. Start postgres + litellm + api
docker compose up --build

# 3. Apply SQL migrations (idempotent)
docker compose exec api npm run migrate
#   ...or from the host against localhost:5432:
#   cd backend && DATABASE_URL=postgresql://assisty:assisty@localhost:5432/assisty npm run migrate

# 4. Verify
curl http://localhost:3000/health
curl http://localhost:3000/health/db
```

Services: **postgres** (5432, pgvector + queue), **litellm** (4000, model gateway),
**api** (3000, NestJS `start:dev`). `pg-boss` provisions its own queue schema on
boot — no manual setup.

## Deploy

Production runs on **Railway** (builds `backend/Dockerfile`, health check at
`/health`) against **Supabase** hosted Postgres. LiteLLM can run as a second
Railway service or be replaced by pointing `LITELLM_BASE_URL` straight at
OpenRouter. WhatsApp webhooks land at `/webhooks/whatsapp` (Meta verify token +
`X-Hub-Signature-256` HMAC). Full instructions, env var list, and Meta webhook
setup are in [docs/DEPLOY.md](./docs/DEPLOY.md).
