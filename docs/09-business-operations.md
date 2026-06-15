# Assisty — Phase 2 Architecture: AI-Native Business Operating Platform

> **Status:** Design (2026-06-02). Evolves Assisty from "AI chatbot builder" → **AI-native commerce/business OS**.
> **Core rule:** **Operational data is structured & relational and is FETCHED, never recalled.** The AI reads it through typed tools against Postgres — it is *never* embedded in the vector store and *never* guessed.

---

## 1. The two kinds of "memory" (read this first)

| | **Knowledge** (fuzzy) | **Operations** (exact) |
|---|---|---|
| Examples | business profile, FAQs, policies, product descriptions, offers, tone | customers, orders, invoices, payments, shipments, tickets |
| Truth model | "what is generally true about the business" | "the exact current state of a specific record" |
| Store | **pgvector (RAG)** — semantic similarity | **relational tables** — keyed, transactional, exact |
| Access | embed query → retrieve top-k chunks → ground the prompt | **typed tool call** → `SELECT … WHERE tenant_id=? AND id=?` → real row |
| Failure if mixed | a stale/embedded "Order #1001 shipped" chunk becomes a **lie** the moment status changes | — |

> **Never put orders/invoices/payments/tracking/CRM into RAG.** Numbers and live state must come from the row, fetched at answer time. RAG is for *prose*, not *records*.

---

## 2. Layered architecture

```
            ┌───────────────────────────────────────────────────────────────┐
            │                    1. AI CONVERSATION LAYER                     │
            │  channels (WhatsApp / web widget / IG)  ·  conversation         │
            │  orchestration  ·  TONE ENGINE (master prompt)  ·  guardrails   │
            │                                                                 │
            │   intent router:  is this a KNOWLEDGE question or an            │
            │                   OPERATIONS question?                          │
            │        │                                   │                    │
            │        ▼ (fuzzy)                           ▼ (exact)            │
            └────────┼───────────────────────────────────┼────────────────────┘
                     │                                   │ typed TOOL calls
        ┌────────────▼───────────┐         ┌─────────────▼──────────────────┐
        │  2. KNOWLEDGE BASE LAYER│         │  3. BUSINESS OPERATIONS LAYER   │
        │  (RAG / pgvector)       │         │  (relational, per-module)       │
        │  • profile  • FAQs      │         │  • Customers / CRM              │
        │  • policies • products  │         │  • Orders     • Invoices        │
        │  • offers   • tone cfg  │         │  • Payments   • Shipments       │
        └─────────────────────────┘         │  • Human Inbox • Analytics      │
                                            └──────────────┬──────────────────┘
                                                           │ emit/consume
                                            ┌──────────────▼──────────────────┐
                                            │  4. EVENT BUS (cross-cutting)    │
                                            │  order.created · payment.received│
                                            │  shipment.dispatched · delivered │
                                            └──────────────────────────────────┘
```

The four layers are **separately deployable concerns** inside the NestJS monolith today (one module each), and can split into services later without changing the contracts.

### Layer 1 — AI Conversation Layer
Owns: channel adapters, conversation state, the **tone engine** (per-tenant master prompt), KB retrieval, guardrails, and the **tool-calling loop**. It does **no business logic** itself — it *asks* the Operations Layer for facts and *narrates* the result.

### Layer 2 — Knowledge Base Layer
Unchanged from Phase 1 (docs/08): profile, FAQs, policies, products/services, offers, tone/personality — all RAG. **Orders/operational data is removed from here.**

### Layer 3 — Business Operations Layer
Independent modules, each owning its own table(s), repository, service, controller, and events. Modules talk to each other **through services and events, never by reaching into each other's tables.**

### Layer 4 — Event Bus
Decouples modules. MVP: in-process `@nestjs/event-emitter` + a **transactional outbox** table for durability; later: pg-boss/queue fan-out. Analytics, Human Inbox, and Automations are pure **consumers**.

---

## 3. How an operational query is answered (the tool pattern — NOT RAG)

Customer: **"Where is my order?"**

```
inbound message (WhatsApp/web)
      │
      ▼
[Conversation Layer] resolve CUSTOMER from channel identity
      │   crm.findByChannel(tenantId, 'whatsapp', '+9230012…')  → customer_id
      ▼
[Conversation Layer] LLM intent + tool-calling (Gemini/OpenAI function calling)
      │   model decides to call:  get_orders_for_customer({ customerId, limit: 1 })
      ▼
[Operations Layer] OrdersService.findRecentForCustomer(tenantId, customerId)
      │   SELECT … FROM orders WHERE tenant_id = $t AND customer_id = $c …  (exact row)
      │   + ShipmentsService.getTracking(order.id)
      ▼
[Conversation Layer] feed the REAL record back to the model → it narrates in the tenant's tone
      ▼
"Your order #1001 shipped on Tue and is out for delivery — tracking TRK123456."
```

**Rules that make this safe:**
- The model may only obtain operational facts by **calling a tool**; it is instructed it must not state order/payment/tracking facts otherwise.
- `tenant_id` (and the resolved `customer_id` for "my order") are **injected server-side** into every tool call — the model never supplies them. (Same guardrail as docs/03 §6d.)
- If a tool returns nothing, the model asks for the order number / offers human handoff — it does **not** invent.

### Tool catalog (initial)
| Tool | Backing service | Returns |
|---|---|---|
| `get_orders_for_customer` | OrdersService | recent orders for the resolved customer |
| `get_order_by_number` | OrdersService | one order by human `order_number` |
| `get_tracking` | ShipmentsService | carrier, tracking #, status, ETA |
| `get_invoice` | InvoicesService | invoice status + link |
| `create_ticket` / `handoff_to_human` | InboxModule | open a human-inbox item |

Tools are registered with the LLM via the OpenAI-compatible `tools` parameter (Gemini supports function calling on this endpoint). The conversation worker runs a bounded loop: model → tool_call → execute → feed result → final answer (max ~3 hops; no open-ended LangGraph).

---

## 4. Orders module (build this module first)

### 4.1 Schema (`orders`) — extends the requested fields with multi-tenant + commerce essentials
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `tenant_id` | uuid FK → tenants | **mandatory** — every row tenant-scoped (RLS) |
| `order_number` | text | human-facing (e.g. "1001"); `UNIQUE(tenant_id, order_number)` |
| `customer_id` | uuid FK → customers | links to CRM |
| `status` | text enum | `pending · confirmed · processing · shipped · delivered · cancelled · refunded` |
| `payment_status` | text enum | `unpaid · pending · paid · partially_refunded · refunded · failed` |
| `tracking_number` | text null | denormalized convenience; authoritative tracking lives in `shipments` |
| `currency` | text | e.g. `PKR` (default per tenant) |
| `subtotal` | numeric(12,2) | |
| `total` | numeric(12,2) | |
| `metadata` | jsonb | channel, notes, etc. |
| `created_at` / `updated_at` | timestamptz | `updated_at` bumped via trigger or service |

Line items live in a child table (don't stuff them in JSON for real commerce):

`order_items`: `id, tenant_id, order_id FK, sku, name, qty, unit_price, line_total`.

Indexes: `(tenant_id)`, `UNIQUE(tenant_id, order_number)`, `(tenant_id, customer_id)`, `(tenant_id, status)`.

### 4.2 Module shape (NestJS)
```
backend/src/operations/orders/
  orders.module.ts
  orders.controller.ts        REST: create/list/get/update-status (operator + API)
  orders.service.ts           business logic; emits events; bumps updated_at
  orders.repository.ts        tenant-scoped SQL only
  orders.events.ts            event names + payload types
  orders.tools.ts             get_orders_for_customer / get_order_by_number (for the AI)
  dto/                        create-order, update-status (zod)
```

### 4.3 Status transitions emit events
`confirm()` → `order.confirmed`; `markPaid()` → `payment.received`; `ship()` → `shipment.dispatched`; `deliver()` → `order.delivered`. Each transition validates the allowed prior state (a small state machine), writes the row in a transaction, then publishes the event after commit (outbox).

---

## 5. Customers / CRM module (needed for "my order")
`customers`: `id, tenant_id, name, created_at` + `customer_identities`: `id, tenant_id, customer_id, channel ('whatsapp'|'web'|'email'|'instagram'), external_id, UNIQUE(tenant_id, channel, external_id)`.

- `crm.findOrCreateByChannel(tenantId, channel, externalId)` — called on every inbound message; links the **conversation → customer**.
- This is what lets "where is *my* order?" resolve without the customer typing an order number.

---

## 6. Event-driven design (decoupling + automations)

```
OrdersService.markPaid()
   └─ tx commit ─► outbox row {event:'payment.received', tenant_id, payload}
                       │ (publisher)
                       ▼
        EventBus ──► InvoicesModule   (auto-generate invoice)
                ──► AnalyticsModule   (increment revenue/metrics)
                ──► AutomationsModule (e.g. send WhatsApp confirmation template)
                ──► InboxModule       (surface to operator if flagged)
```

- **Canonical events:** `order.created`, `order.confirmed`, `payment.received`, `shipment.dispatched`, `order.delivered`, `order.cancelled`, `invoice.created`, `conversation.handoff_requested`.
- **Payload contract:** every event carries `tenant_id`, `occurredAt`, an `id`, and a typed `data` object. Consumers are idempotent (dedupe by event id).
- **Durability:** a `domain_events` outbox table (written in the same transaction as the state change) → a publisher dispatches to in-process listeners now, pg-boss fan-out later. No event is lost on crash.

---

## 7. Multi-tenant safety (non-negotiable, every module)
- Every operational table has `tenant_id`; **RLS + FORCE RLS** as in docs/03; the app role is non-superuser; `SET LOCAL app.tenant_id` per request/job.
- Every repository method takes `tenantId` as the first argument; no cross-tenant query is expressible.
- **AI tool calls never accept a tenant_id or customer_id from the model** — both are injected from the authenticated conversation/session server-side.
- Events carry `tenant_id`; consumers re-scope before any write.

---

## 8. Module independence (avoid the monolith trap)
- Modules expose **services** (typed methods) + **events**; they do **not** import each other's repositories or query each other's tables.
- Cross-module needs go through the owning service (`InvoicesService.createFromOrder(order)`), or asynchronously via an event.
- The Conversation Layer depends on Operations **only through the tool interface** (`orders.tools.ts`, etc.), so swapping/También scaling a module doesn't touch the AI.

---

## 9. What changes vs Phase 1
- ➖ **Remove the `orders` RAG collector** (docs/08 test shortcut). Orders are relational now; the AI reads them via `get_order*` tools.
- ➕ Conversation worker gains a **tool-calling loop** (bounded) + a **customer-resolution** step.
- ➕ New `operations/` modules + an `events/` module (outbox + bus).
- KB Layer keeps: profile, FAQs, policies, products, offers, tone. (Products stay in RAG as *descriptions*; **stock/price-as-fact for an order** comes from the order/catalog tables, not RAG.)

---

## 10. Proposed repo structure
```
backend/src/
  channels/        (Layer 1 — whatsapp, web widget, instagram)
  conversations/   (Layer 1 — orchestration, tone engine, tool-loop)
  ai/  rag/  kb/   (Layer 1 retrieval + Layer 2 knowledge)
  operations/      (Layer 3)
    crm/  orders/  invoices/  payments/  shipments/  inbox/  analytics/
  events/          (Layer 4 — outbox table, publisher, bus, event contracts)
```

---

## 11. Implementation roadmap (your priority order)
1. **Flutter operator dashboard** — shell + auth + live conversation view (read the data we already persist).
2. **CRM / conversation visibility** — customers + conversation list/detail in the dashboard; `crm` module + identity resolution.
3. **Orders module** — schema + service + REST + `get_order*` tools + wire the tool-loop into the conversation worker. (First Operations module.)
4. **Invoice system** — `invoices` + auto-create on `payment.received`.
5. **Shipment tracking** — `shipments` + `get_tracking` tool + carrier fields.
6. **Automations / orchestration** — event-driven flows (e.g. send WhatsApp template on `shipment.dispatched`).

> **Decision needed:** start with **#1 Flutter dashboard** (per this list) or jump straight to the **Orders backend module + tool-calling** (proves the operational-data-via-tools pattern end-to-end first, and the dashboard will need these APIs anyway). Both are valid; the Orders backend is the smaller, higher-leverage first step.

*Related: [ADR-0004 — operational data is relational, not RAG](./ADR-0004-operational-data-relational.md) · [08-knowledge-base.md](./08-knowledge-base.md) · [02-ai-brain.md](./02-ai-brain.md) · [03-security.md](./03-security.md).*
