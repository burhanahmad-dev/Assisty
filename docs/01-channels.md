# Channel Integrations

> **Scope.** How Assisty connects each business (tenant) to its own messaging channels, normalizes everything into one canonical message, and keeps the AI core completely channel-agnostic. This document is the contract between the **Channel Connector** layer and the rest of the stack (Edge → Supabase Queues (pgmq) → AI Worker → System of Record).
>
> **Authoritative architecture.** NestJS Edge on Cloud Run / Fly.io / Railway (the single shared webhook receiver, `min-instances=1`) → Supabase Queues (pgmq) + pg_cron → NestJS AI Worker fleet → Supabase Postgres 16 + pgvector (RLS + `FORCE ROW LEVEL SECURITY`) → LiteLLM Proxy. Channel tokens are protected by Supabase Vault (pgsodium AEAD, per-DB root key) plus an app-level per-tenant AES-256-GCM layer (so deleting the per-tenant app key crypto-shreds the tenant). The backend platform decision is **ADR-0002** (`docs/ADR-0002-supabase-backend.md`). Nothing here contradicts that; this doc fills in the channel half.

---

## 0. TL;DR for the builder

- **Build first, in order:** WhatsApp Cloud API → Web widget → Email. These three carry the MVP because they are 100% under our control or require no Meta App Review on the critical path.
- **Build second, behind App Review:** Instagram DM + Messenger (one connector, shared Meta Graph API). Start Business Verification on day one because it takes **weeks to months**.
- **Do not build:** TikTok DM automation. No open API, partner-gated, geo-blocked for US/EEA/UK/CH. Saying "coming soon" here is a lie that will burn trust. Out of scope.
- **The one abstraction that matters:** every channel implements a single `ChannelAdapter` interface. The AI Worker never imports a channel SDK. It speaks only `CanonicalMessage` in and `OutboundReply` out.
- **The one rule that prevents the #1 multi-tenant outage:** after WhatsApp Embedded Signup you **must** call `POST /{waba_id}/subscribed_apps` (and `POST /{phone_number_id}/register`). Skip it and you get zero inbound webhooks, silently. It is no longer auto-created (changed late 2025).

---

## 1. The Channel Adapter abstraction (read this before any channel)

The AI core must not know whether a message came from WhatsApp or a web widget. We achieve this with two normalization seams:

1. **Inbound normalize** — each raw channel payload → one `CanonicalMessage`.
2. **Outbound render** — one `OutboundReply` → the specific channel API call.

```
                         ┌──────────────────────────────────────────────┐
   WhatsApp Cloud API ─┐ │  EDGE (NestJS, Cloud Run/Fly/Railway, min=1)   │
   Meta Graph (IG/MSG) ─┤ │  POST /webhooks/:channel  (ONE shared URL/ch.) │
   Web widget (RT/WS) ──┤ │  1. read RAW body                              │
   Email (Mailgun)    ─┘ │  2. verify HMAC (X-Hub-Signature-256 / own)    │
                         │  3. resolve tenant from payload identifiers     │
                         │  4. dedupe (unique provider-msg-id + idemp tbl) │
                         │  5. return 200 in ~50ms                         │
                         │  6. enqueue CanonicalMessage → pgmq             │
                         └───────────────────────┬──────────────────────┘
                                                  │ inbound-messages queue
                                                  ▼
                         ┌──────────────────────────────────────────────┐
                         │  AI WORKER (channel-AGNOSTIC)                  │
                         │  SET LOCAL app.tenant_id  →  RLS active        │
                         │  cap check → RAG (pgvector) → LiteLLM → reply  │
                         │  emits OutboundReply (canonical)               │
                         └───────────────────────┬──────────────────────┘
                                                  │ outbound-send queue
                                                  ▼
                         ┌──────────────────────────────────────────────┐
                         │  ChannelAdapter.send()  (per-channel render)   │
                         │  enforces 24h-window / template rules          │
                         │  → WhatsApp send | Graph send | RT push | SMTP │
                         └──────────────────────────────────────────────┘
```

### 1.1 Canonical inbound message

```ts
// One shape for every inbound message, regardless of channel.
interface CanonicalMessage {
  tenantId: string;            // resolved SERVER-SIDE from the payload, never trusted from it
  channel: ChannelType;        // 'whatsapp' | 'instagram' | 'messenger' | 'web' | 'email'
  channelAccountId: string;    // phone_number_id | ig_account_id | page_id | widget_key | inbox_addr
  conversationKey: string;     // stable thread id (see §1.4)
  providerMessageId: string;   // wamid | mid | Message-ID — the idempotency key
  contact: {
    externalId: string;        // wa phone / IGSID / PSID / web visitor id / email addr
    displayName?: string;
    locale?: string;
  };
  content: {
    type: 'text' | 'image' | 'audio' | 'video' | 'document' | 'location' | 'postback' | 'unsupported';
    text?: string;
    mediaRefs?: MediaRef[];    // we store our own copy; never hotlink Meta CDN (expiring URLs)
    raw?: unknown;             // original payload kept for replay/debug, NEVER logged with PII
  };
  windowState: {               // channels with a customer-care window populate this
    lastInboundAt?: string;    // ISO; used to compute the open 24h window
    isWindowOpen: boolean;
  };
  receivedAt: string;          // ISO, server clock
}
```

### 1.2 Canonical outbound reply

```ts
interface OutboundReply {
  tenantId: string;
  channel: ChannelType;
  conversationKey: string;
  to: { externalId: string };
  body:
    | { kind: 'text'; text: string }
    | { kind: 'media'; mediaRef: MediaRef; caption?: string }
    | { kind: 'template'; templateName: string; lang: string; variables: Record<string, string> }
    | { kind: 'quickReplies'; text: string; options: { id: string; label: string }[] };
  // The adapter decides if `template` is REQUIRED (window closed) and rejects free-form if so.
  idempotencyKey: string;      // so an outbound retry never double-sends
}
```

### 1.3 The interface every channel implements

```ts
interface ChannelAdapter {
  readonly type: ChannelType;

  // EDGE side -----------------------------------------------------------
  verifySignature(req: RawRequest): boolean;            // HMAC / token check
  resolveTenant(payload: unknown): Promise<TenantRef>;  // identifier → tenant (cached, §3.3)
  parseInbound(payload: unknown): CanonicalMessage[];    // one webhook → N messages

  // WORKER side ---------------------------------------------------------
  canSendFreeForm(window: WindowState): boolean;        // 24h-window logic, channel-specific
  send(reply: OutboundReply, creds: DecryptedCreds): Promise<SendResult>;

  // LIFECYCLE -----------------------------------------------------------
  onboard?(tenantId: string, input: OnboardInput): Promise<ChannelConnection>;
}
```

**Why this matters.** New channels are additive: implement the interface, register it in the connector factory, done. The Worker, the RAG path, the usage ledger, the audit log — none of them change. The `windowState` + `canSendFreeForm()` pair is what lets WhatsApp, Instagram, and Messenger share the exact same 24h-window mental model while web and email simply return `true`.

### 1.4 Conversation keying (so memory and threading are consistent)

Conversation memory in the brain is keyed by `(tenant_id, conversation_id)` — never global. The adapter is responsible for producing a **stable** `conversationKey`:

| Channel | conversationKey derivation |
|---|---|
| WhatsApp | `wa:{phone_number_id}:{customer_wa_id}` |
| Instagram | `ig:{ig_account_id}:{IGSID}` |
| Messenger | `msg:{page_id}:{PSID}` |
| Web widget | `web:{widget_key}:{visitor_id}` (visitor id from HMAC identity or anon cookie) |
| Email | thread root `Message-ID`, then matched via `References`/`In-Reply-To` |

---

## 2. Per-channel feasibility table

| Channel | Feasible? | Gating dependency | Critical platform facts | MVP priority |
|---|---|---|---|---|
| **WhatsApp Business Cloud API** | ✅ Yes | Meta **Tech Provider** app + Embedded Signup config | Cloud API only (On-Prem EOL **Oct 23, 2025**). Per-message pricing since **Jul 1, 2025**. 24h service window. Tiered 250→1k→10k→100k→unlimited. ~80 msg/s default. | **P0 — ship first** |
| **Web chat widget** | ✅ Yes, fully ours | None (we own it end-to-end) | JS loader → sandboxed iframe, publishable + secret key, HMAC identity verification, Supabase Realtime (SSE/REST fallback). Chatwoot is the reference design. | **P0** |
| **Email** | ✅ Yes, fully ours | DNS access (SPF/DKIM/DMARC) | Inbound via Mailgun Routes or SendGrid Inbound Parse. Thread by `Message-ID`/`References`. No real-time window constraint. | **P0** |
| **Messenger (FB Page)** | ✅ Yes | **Meta App Review + Business Verification** (weeks–months) | Shared Graph API + Send API. 24h window. Past 24h: human-agent tag = **humans only, no bot automation**. Legacy message tags die **Apr 27, 2026**. | **P1** |
| **Instagram DM** | ✅ Yes (with Messenger) | Same App Review + Business Verification | Same Graph API, same window/webhook/Send model as Messenger. Build them as **one connector**. | **P1** |
| **TikTok DM** | ❌ **No** | Partner-gated, **geo-blocked US/EEA/UK/CH**, Beta only | No open Business Messaging API. Do **not** promise automation to those markets. | **Out of scope** |

---

## 3. WhatsApp Business Cloud API

WhatsApp is the flagship channel and the one with the most moving parts. We register as a **Meta Tech Provider** (not a BSP). The consequence is strategic: each tenant attaches **their own** payment method to their WABA, so Meta bills the tenant directly for messages → **zero messaging markup**. We bill software only.

### 3.1 Onboarding: Embedded Signup

We never ask a tenant to copy/paste tokens or phone-number IDs. They click one button; Meta's Embedded Signup flow handles WABA creation, phone number registration, and consent.

```
TENANT BROWSER (Flutter web view / dashboard)
  │  FB.login({
  │     config_id:    '<our Embedded Signup config id>',
  │     response_type:'code',
  │     override_default_response_type: true,
  │     extras: { setup: {...}, featureType: '', sessionInfoVersion: '3' }
  │  })                      // solutionID is baked into our config
  │
  ├─► message event 'WA_EMBEDDED_SIGNUP'  → { waba_id, phone_number_id }
  │      (capture via window.addEventListener('message', ...))
  │
  └─► FB.login callback      → { authResponse.code }   // short-lived auth code
            │
            ▼
   POST /api/channels/whatsapp/connect  { code, waba_id, phone_number_id }
            │  (EDGE service)
            ▼
   Backend exchanges code → Business Integration System User token
   GET /oauth/access_token?client_id=APP_ID&client_secret=APP_SECRET
       &code=CODE&grant_type=authorization_code
            │  token is EFFECTIVELY NON-EXPIRING (system user token)
            ▼
   Encrypt the token (Supabase Vault pgsodium AEAD + app-level per-tenant
       AES-256-GCM layer; delete the per-tenant app key to crypto-shred)
   Persist ONE channel_connection row for this tenant
            │
            ▼
   ── TWO MANDATORY POST-ONBOARDING CALLS ──  (see §3.2)
```

**Frontend detail that bites people:** the `WA_EMBEDDED_SIGNUP` payload (with `waba_id` and `phone_number_id`) arrives via a `postMessage` event, *separately* from the `code` in the `FB.login` callback. You must capture both and correlate them before calling the backend. If you only read the callback you will have a `code` but no `waba_id`.

### 3.2 The two mandatory post-onboarding calls (the #1 failure mode)

After the code exchange, **before** you tell the tenant "connected," run both of these with the freshly minted token. Skipping the first one is the single most common multi-tenant WhatsApp outage.

```http
# 1. Subscribe OUR app to this tenant's WABA so inbound webhooks flow.
#    NO LONGER auto-created since late 2025. Skip = zero inbound messages, silently.
POST https://graph.facebook.com/v21.0/{waba_id}/subscribed_apps
Authorization: Bearer {system_user_token}

# 2. Register the phone number on Cloud API with a 6-digit PIN
#    (the tenant chooses/sets it; required to send & receive).
POST https://graph.facebook.com/v21.0/{phone_number_id}/register
Authorization: Bearer {system_user_token}
{ "messaging_product": "whatsapp", "pin": "123456" }
```

Gate the "✅ WhatsApp connected" UI state on **both** returning success. Store the outcome on the connection row so a re-onboard can detect and repair a half-finished connect.

### 3.3 Per-tenant storage and webhook routing

We expose **one shared webhook URL** for all tenants: `POST /webhooks/whatsapp`. Meta does not tell us which tenant a message belongs to — we derive it from identifiers in the payload.

```
channel_connection  (one row per tenant per WhatsApp number)
┌─────────────────────────────────────────────────────────────────────┐
│ id                  uuid                                              │
│ tenant_id           uuid     ── RLS, every index leads with this      │
│ channel             'whatsapp'                                        │
│ waba_id             text     ── routing key                           │
│ phone_number_id     text     ── routing key (UNIQUE, primary lookup)  │
│ display_phone       text                                             │
│ token_ciphertext    bytea    ── AES-256-GCM(token), app-level layer   │
│ token_vault_id      uuid     ── Supabase Vault (pgsodium) secret ref  │
│ token_iv            bytea                                            │
│ token_auth_tag      bytea                                            │
│ subscribed_apps_ok  boolean                                          │
│ registered_ok       boolean                                          │
│ created_at          timestamptz                                      │
└─────────────────────────────────────────────────────────────────────┘
UNIQUE (phone_number_id)        -- one number belongs to exactly one tenant
INDEX (tenant_id, channel)      -- tenant-led, per the security baseline
```

**Routing on inbound (the hot path):**

```
POST /webhooks/whatsapp
  1. body = readRawBody(req)                     // raw bytes, NOT parsed JSON
  2. assert hmacSha256(APP_SECRET, body) == header['X-Hub-Signature-256']  // constant-time
  3. phone_number_id = body.entry[].changes[].value.metadata.phone_number_id
  4. tenant = cache.get(phone_number_id) ?? db.lookupByPhoneNumberId(phone_number_id)
        // lookup runs OUTSIDE tenant RLS (it IS the tenant resolver); cached in-process
  5. wamid = body...messages[].id
     INSERT INTO inbound_idempotency(wamid) ...    // UNIQUE(wamid) constraint
     if (unique_violation) return 200              // duplicate redelivery, drop
  6. return 200                                  // within ~50ms, BEFORE any AI work
  7. enqueue parseInbound(body) → pgmq inbound-messages  (rate-limit group = tenant_id)
```

Rules, restated because each one is load-bearing:

- **Verify `X-Hub-Signature-256` over the raw body** with the **Meta app secret**, constant-time compare, 5-minute timestamp tolerance. Parse the body *after* verifying.
- **Resolve tenant from `phone_number_id`** (fall back to `waba_id`). Never trust any tenant identifier supplied in the payload.
- **Return 200 fast, process async.** Meta retries aggressively on slow/failed responses; the webhook thread does zero LLM work.
- **Dedupe on `wamid`** via a Postgres `UNIQUE (wamid)` constraint + an idempotency table — Meta redelivers, and double-processing means double AI spend.

### 3.4 The 24-hour window, templates, and pricing

This is where pricing copy and engineering meet. Get the window logic wrong and you either silently fail to reply or you bill the tenant for a paid template when a free reply was allowed.

```
                  customer sends a message
                            │
                            ▼
        ┌──────── 24h CUSTOMER SERVICE WINDOW opens ────────┐
        │  inside window:                                    │
        │   • free-form (Service) replies        → FREE      │
        │   • Utility templates                  → FREE      │
        │   • Marketing / Authentication tmpl    → PAID      │
        └────────────────────────────────────────────────────┘
                            │  window closes after 24h of customer silence
                            ▼
        outside window:
          • free-form NOT allowed (API rejects it)
          • must send an approved TEMPLATE
          • Utility / Marketing / Authentication  → PAID
```

`canSendFreeForm(window)` for WhatsApp returns `window.isWindowOpen`. The worker computes `isWindowOpen = now - lastInboundAt < 24h`. If the worker wants to send free-form text but the window is closed, the adapter **rejects** it and the reply must be re-expressed as an approved template (`body.kind === 'template'`).

**Pricing facts to encode and to surface honestly in the dashboard:**

- Pricing is **per-message** since **Jul 1, 2025** (not per-conversation anymore).
- **Service** messages (free-form, inside the open 24h window): **free**.
- **Utility** templates: **free when sent inside the open 24h window**, paid outside it.
- **Marketing** and **Authentication** templates: **always paid**.
- **Hidden Meta per-message fees can make real cost 2–5× the sticker rate.** Our pricing UI must say this in plain language — never imply WhatsApp is "free" because we add zero markup. The tenant pays Meta directly (Tech Provider model); we show estimated cost, not an invoice.

**Throughput / tiers** (for rate-limit configuration and onboarding expectations):

| Tier | Unique customers / 24h | Notes |
|---|---|---|
| Unverified | 250 | Default at first connect |
| 1 | 1,000 | After business verification |
| 2 | 10,000 | Auto-scales with quality + volume |
| 3 | 100,000 | |
| 4 | Unlimited | |

Default throughput ~**80 msg/s** (can rise to 1,000). Tiering is **portfolio-based** since Oct 2025. Configure the pgmq `outbound-send` rate-limit group per tenant to stay under their tier. (If richer queue semantics are ever needed, **Upstash Redis + BullMQ** is the kept-on-file alternative.)

### 3.5 Sending (outbound render)

```http
POST https://graph.facebook.com/v21.0/{phone_number_id}/messages
Authorization: Bearer {decrypted system_user_token}
Content-Type: application/json

# free-form (window open)
{ "messaging_product": "whatsapp", "to": "<wa_id>",
  "type": "text", "text": { "body": "..." } }

# template (window closed)
{ "messaging_product": "whatsapp", "to": "<wa_id>",
  "type": "template",
  "template": { "name": "order_update", "language": { "code": "en_US" },
    "components": [ ... ] } }
```

The send response returns a `wamid`; persist it on the message row. Status webhooks (`sent`/`delivered`/`read`/`failed`) arrive on the **same** `/webhooks/whatsapp` URL — route them the same way and use them to drive `messages_sent` metering and delivery state in the dashboard.

---

## 4. Instagram DM + Messenger (Meta Graph API)

Build these as **one connector** (`MetaGraphAdapter` with a `surface: 'instagram' | 'messenger'` discriminator). They share the Graph API, the Send API, the 24-hour messaging window, and the webhook model. The only meaningful differences are the identifiers (`IGSID`/`ig_account_id` vs `PSID`/`page_id`) and the connected-asset onboarding.

### 4.1 The gating reality (plan your launch around it)

- **Meta App Review + Business Verification** are required and are **slow — weeks to months**. Start the moment you have a real app; do not put Instagram/Messenger on the MVP critical path.
- These permissions are needed: `instagram_manage_messages`, `pages_messaging`, `pages_manage_metadata`, plus the underlying business asset access.
- This is exactly why **WhatsApp + web widget + email carry the MVP**. Treat IG/MSG as a fast-follow that unlocks when Meta approves.

### 4.2 Window and the human-agent rule (this changes product behavior)

The standard messaging window is **24 hours** from the user's last message, same shape as WhatsApp. Outside it, the situation is stricter than WhatsApp:

- The **human-agent tag** extends the window to 7 days **but is for humans only** — Meta prohibits using it for bot/automated replies. So **Assisty's AI cannot auto-respond past 24h** on IG/MSG; past-window replies must route to a human operator in the dashboard.
- **Legacy message tags are deprecated and die Apr 27, 2026.** Do not design any flow that depends on them.

`canSendFreeForm()` for this adapter returns `isWindowOpen`; when closed, the worker does **not** generate an AI reply — it flags the conversation for human handoff. Encode this as a hard guardrail, not a soft preference.

### 4.3 Webhook routing

Same pattern as WhatsApp: one shared URL per surface (or one with a `field` discriminator), verify `X-Hub-Signature-256` against the app secret, resolve tenant from `page_id` (Messenger) or `ig_account_id` (Instagram), dedupe on `mid` (Postgres `UNIQUE` + idempotency table), return 200 fast, enqueue. Tokens are **Page access tokens** obtained at connect time and stored under the same Supabase Vault + app-level per-tenant AES-256-GCM scheme as WhatsApp, one connection row per tenant per asset.

---

## 5. TikTok — honest feasibility

**Not feasible. Out of scope. Do not promise it.**

- There is **no open Business Messaging API** for TikTok DMs.
- Access is **partner-gated** and in **Beta**.
- It is **geo-blocked for businesses in the US, EEA, UK, and Switzerland** — i.e., most of our likely market.

The only responsible posture is to treat TikTok as **partner-mediated / out of scope** and to **not** list "TikTok DM automation" anywhere in marketing or the channel picker. If a tenant asks, the honest answer is: "TikTok has no open messaging API and is geo-blocked for your region; we'll integrate it the moment Meta-style open access exists." Putting a greyed-out "coming soon" TikTok tile in the UI is worse than omitting it — it implies a roadmap commitment we cannot keep.

---

## 6. Website chat widget (fully ours)

The widget is the channel we fully control end-to-end, with no third-party gatekeeper. It is the reference implementation of the adapter pattern and the fastest path to a live demo. **Chatwoot's widget is the design reference.**

### 6.1 Architecture

```
TENANT'S WEBSITE
  <script async src="https://cdn.assisty.app/widget.js"
          data-assisty-key="pk_live_ab12..."></script>
        │  loader script (tiny, ~3KB)
        ▼
  Injects a SANDBOXED <iframe src="https://widget.assisty.app/?key=pk_live_...">
        │  iframe isolates our CSS/JS from the host page (and vice versa)
        ▼
  Inside iframe:
   • subscribes via Supabase Realtime (Postgres CDC over WebSocket)
   • posts messages    POST /widget/messages   (REST; Realtime is receive-only)
   • SSE / REST polling fallback if the Realtime socket drops
```

**Why Supabase Realtime:** the live receive path is **Supabase Realtime (Postgres CDC over WebSocket)** — new message rows stream to the widget as they are written, with no extra fan-out infra. **SSE remains a fallback** for environments that block the WebSocket (and the synchronous edge process itself stays a long-lived Node host on Cloud Run / Fly.io / Railway, not a Supabase Edge Function).

### 6.2 Keys: publishable vs secret

| Key | Prefix | Lives where | Purpose |
|---|---|---|---|
| Publishable key | `pk_live_…` | Client-side, in the embed snippet | Identifies the tenant + widget config; safe to expose; resolves tenant on the widget webhook path |
| Secret key | `sk_live_…` | Tenant's **server only** | Signs the HMAC identity payload to verify a logged-in visitor's identity |

The publishable key is the `channelAccountId` / routing key for the widget adapter. It maps to exactly one tenant (same `UNIQUE` + tenant-led-index discipline as `phone_number_id`).

### 6.3 HMAC identity verification (so a visitor can't impersonate another)

For authenticated sites, the tenant's backend signs the visitor's identity so we can trust it:

```js
// On the TENANT's server (uses their SECRET key — never shipped to the browser):
const identityHash = crypto
  .createHmac('sha256', TENANT_SECRET_KEY)
  .update(loggedInUserId)        // e.g. their internal user id
  .digest('hex');

// Passed into the widget boot call client-side:
Assisty('identify', { userId: loggedInUserId, userHash: identityHash, email, name });
```

Our backend recomputes the HMAC with the tenant's secret key and rejects mismatches. Anonymous visitors get a signed first-party cookie visitor id. Either way, `conversationKey = web:{widget_key}:{visitor_id}`.

`canSendFreeForm()` always returns `true` — there is no platform-imposed window. The brain replies in realtime over Supabase Realtime (SSE fallback).

---

## 7. Email

Email is fully under our control via a transactional provider's **inbound parsing**. **Mailgun Routes** or **SendGrid Inbound Parse** — pick one, abstract behind the adapter.

### 7.1 Flow

```
Customer emails  support@{tenant-subdomain}.assisty.app   (or tenant's own domain via MX)
        │
        ▼
  Mailgun Route / SendGrid Inbound Parse  → POST /webhooks/email  (multipart payload)
        │  EDGE: verify provider signature, resolve tenant from the inbox address
        ▼
  parseInbound → CanonicalMessage
        │   conversationKey = thread root Message-ID
        │   thread match via References / In-Reply-To headers
        ▼
  Worker generates reply → adapter sends via provider's outbound API (SMTP/HTTP)
        with proper In-Reply-To / References so it threads in the customer's client
```

### 7.2 Deliverability (non-negotiable DNS)

For every tenant sending domain, set up and verify **SPF, DKIM, and DMARC**. Without these, replies land in spam and the channel is functionally dead. Bake domain verification into the email-channel onboarding wizard (show the exact DNS records to add, then poll for verification before flipping the channel to "active").

- **Tenant resolution:** by destination inbox address (the routing key).
- **Threading:** by `Message-ID` for the root, then `References` / `In-Reply-To` to attach subsequent mails to the same conversation.
- **No 24h window:** `canSendFreeForm()` returns `true`. Email is async by nature.
- **Idempotency:** dedupe on `Message-ID`.

---

## 8. Cross-channel invariants (apply to every adapter)

These are the rules that keep the channel layer secure and the brain channel-agnostic. They are restated here so a new adapter author has a checklist.

1. **One shared webhook URL per channel; resolve tenant from payload identifiers.** Never trust a tenant id supplied in a webhook body.
2. **Verify the signature over the RAW body** (`X-Hub-Signature-256` for Meta channels using the app secret; provider signature for Mailgun/SendGrid; HMAC for the widget). Constant-time compare, 5-minute timestamp tolerance.
3. **Return 200 in ~50ms, then enqueue.** Zero LLM work on the webhook thread.
4. **Dedupe on the provider message id** (`wamid` / `mid` / `Message-ID`) via a Postgres `UNIQUE` constraint + an idempotency table.
5. **Tokens are encrypted (Supabase Vault pgsodium AEAD + an app-level per-tenant AES-256-GCM layer for crypto-shred), one connection row per tenant.** Decrypt only inside the worker, in-memory, for the single send; never log plaintext. GDPR-erasure = delete the per-tenant app key.
   - **`service_role` bypasses RLS** (the same flaw that disqualified Firebase) — the edge and AI worker MUST use a dedicated tenant-scoped non-superuser role with RLS enforced and `SET LOCAL app.tenant_id` per transaction, **NEVER** `service_role` for tenant data. Use Supabase's pooler (Supavisor) in transaction mode.
6. **Window rules live in the adapter** (`canSendFreeForm()` + `windowState`), so the brain only asks "may I send free-form?" and never learns WhatsApp's vs Instagram's specifics.
7. **`tenant_id` is set via `SET LOCAL app.tenant_id` per transaction** in the worker before any DB access — RLS does the rest. The tenant-resolution lookup (identifier → tenant) is the *only* query that runs outside tenant scope, and it touches no tenant-scoped data beyond the mapping.
8. **Re-stamp `tenant_id` server-side on every write** from any less-trusted async plane (ingestion, future n8n outbound integrations) as defense-in-depth, even though RLS backstops it.
9. **Metering is emitted by the outbound path**, not the channel SDK: every successful `send()` enqueues a `billing-meter` job (`messages_sent`) and the worker writes `ai_tokens` to the internal usage ledger — the source of truth checked *before* the model call.

---

## 9. Build order and dependency summary

```
WEEK 0 ──► Start Meta Business Verification + App Review  (long pole, runs in background)
            Register as Meta Tech Provider, create Embedded Signup config

P0  ──────► WhatsApp Cloud API   (Embedded Signup, 2 mandatory calls, shared webhook, window+pricing)
            Web widget          (loader → iframe, pk/sk keys, Supabase Realtime + SSE/REST fallback, HMAC identity)
            Email               (Mailgun/SendGrid inbound, SPF/DKIM/DMARC, Message-ID threading)
                                  ▲ these three SHIP the MVP

P1  ──────► Instagram DM + Messenger  (one MetaGraphAdapter; unlocks when App Review passes)
            ▲ human-agent rule: NO AI auto-reply past the 24h window → route to human

NEVER ────► TikTok DM automation (no open API, geo-blocked, partner-gated) — out of scope, not promised
```

The `ChannelAdapter` interface is the constant across all of it. The AI core — RAG over pgvector, LiteLLM model routing, per-tenant virtual keys, the usage-ledger cap check, server-injected `tenant_id` on every tool call — never changes when a channel is added. That is the whole point: **own the runtime, rent the models, and keep the brain channel-agnostic.**
