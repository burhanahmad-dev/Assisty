# Assisty — ADR-0003: Product & Scope Decisions (MVP)

> **Status:** ACCEPTED (2026-06-01). Founder decisions that resolve the open questions raised in [07-review-gaps-risks.md](./07-review-gaps-risks.md). These bind the MVP scope.

## 1. Channels (MVP)

| Channel | MVP? | Notes |
|---|---|---|
| WhatsApp (Cloud API) | ✅ | Flagship. Meta Tech Provider model. |
| Website chat widget | ✅ | Fully under our control. |
| Email | ✅ | Inbound via provider (Mailgun/SendGrid). |
| **Facebook Messenger** | ✅ (post-approval) | Meta Graph; gated by Meta App Review + Business Verification. |
| **Instagram DM** | ✅ (post-approval) | Shares Meta Graph with Messenger; same review gate. |
| **TikTok** | ⛔ **Waitlist slot only** | There is **no third-party API for TikTok DM/customer-service automation** (partner-gated, geo-restricted). We expose TikTok in the channel UI as **"coming soon"** and implement it behind the standard `Channel` adapter the moment an official API is available. **We do not promise working TikTok automation at launch.** |

**Decision:** Build the `Channel` adapter abstraction so Messenger + Instagram drop in after Meta approval, and TikTok drops in if/when an API exists — without touching the AI core. MVP can launch on WhatsApp + Web + Email while Meta review is pending.

## 2. AI models

- **Launch:** OpenAI **GPT** + Google **Gemini** + **free/open models** (founder will supply API keys later).
- **Anthropic (Claude):** not at launch, but **addable via a single LiteLLM config entry** — no code change.
- The tenant's selectable model is gated by plan (free tier → free models; paid tiers → premium GPT/Gemini). Routing is handled by the **LiteLLM gateway** with per-tenant virtual keys (see [02-ai-brain.md](./02-ai-brain.md)).

## 3. Markets & data residency

- **Target:** United States, Pakistan, and **all other countries EXCEPT Israel** (hard geo-block).
- **Primary region:** a **US** Supabase region (serves US + Pakistan + global well).
- **GDPR:** not EU-first, but the security/erasure design (crypto-shred, audit log) is retained so EU expansion isn't blocked later. Revisit a regional/EU Supabase project only when EU demand justifies it.

## 4. Billing & plans

- **Free trial:** **1 week** of paid-tier features for new signups.
- **After trial (no subscription):** the tenant drops to an **ad-supported Free tier** that runs on **free/open models** (lower quality, capped).
- **Paid tiers:** premium models (GPT/Gemini), **no ads**, higher caps.
- Enforcement still uses the internal **`usage_ledger`** with pre-flight hard caps (see [05-onboarding-billing.md](./05-onboarding-billing.md)); ads are a Free-tier monetization layer, not a billing-engine change.
- Stripe for paid subscriptions; Google Play cloud-software exemption keeps checkout on web (no Play fee).

## 5. Explicitly deferred (next update, not MVP)

- **Live catalog sync** (Shopify/WooCommerce). MVP catalog = manual entry + CSV + website-scan extraction (one-time/scheduled), **not** real-time stock sync.
- **Agency / reseller mode** (one operator managing many businesses). MVP = one operator account ↔ one tenant.

## 6. Consequences

- The **Knowledge Base** module ([08-knowledge-base.md](./08-knowledge-base.md)) ships its website-scan + manual + file + learn-from-chat sources, but the **Shopify live-sync connector is stubbed** (UI shows "coming soon").
- The **channel registry** ships with WhatsApp/Web/Email active, Messenger/Instagram behind a Meta-approval flag, and **TikTok as a disabled "waitlist" entry**.
- Auth/billing assume a **single tenant per operator**; the schema keeps `tenant_id` as the hard boundary so agency mode is an additive change later, not a migration.

*Related: [ADR-0001](./ADR-0001-architecture-choice.md) (architecture choice) · [ADR-0002](./ADR-0002-supabase-backend.md) (Supabase backend).*
