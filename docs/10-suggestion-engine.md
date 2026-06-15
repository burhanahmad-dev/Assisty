# Assisty — Suggestion & Recommendation Engine

> **Status:** Design (2026-06-02). A sub-system of the **AI Conversation Layer** (docs/09) that, on every turn, reads the customer's *interest direction* and surfaces **relevant, actionable suggestions** — products, next steps ("place order"), and attribute prompts (size, colour) — as **structured data** the UI renders as chips/buttons/cards.
>
> **Hard rule (inherited):** suggested products, prices, variants and stock come from the **structured catalog (Operations Layer)** — the model may only surface items we hand it; it never invents products, prices, sizes, or availability.

---

## 1. What it does (the example, generalised)

```
Customer: "I'm looking for running shoes"
   → detect INTEREST: category=shoes, use=running
   → candidate PRODUCTS from catalog (in-stock, matching)        [Operations]
   → reply: "We've got a few great runners 👟" + PRODUCT CARDS
   → quick replies: [ Nike Pegasus ] [ Adidas Ultra ] [ See all shoes ]

Customer: taps "Nike Pegasus"
   → stage = variant_selection; product needs {size, colour}
   → ATTRIBUTE PROMPTS: size chips [7][8][9][10] · colour chips [Black][White][Blue]
   → reply: "Nice pick! What size and colour?"

Customer: "size 9, black"
   → all required attributes filled, variant in stock
   → NEXT-BEST-ACTION = place_order
   → quick replies: [ ✅ Place order ] [ Add another ] [ Ask a question ]
```

Every turn produces a **reply + a `suggestions` object**. The text stays conversational; the suggestions are structured so any channel can render them and so taps are trackable.

---

## 2. Where it sits

```
AI CONVERSATION LAYER
  ├─ InterestTracker      → maintains a per-conversation interest profile
  ├─ SuggestionEngine     → candidates + next-best-action + ranking → Suggestions
  │     ├─ reads CatalogService (Operations: products + variants, price, stock)   ← EXACT
  │     ├─ reads RAG (KB product descriptions) for semantic matching              ← FUZZY
  │     └─ reads conversation stage + interest profile
  └─ Reply composer (LLM) → phrases the reply referencing the chosen suggestions
KNOWLEDGE LAYER (RAG)      → product *descriptions* for semantic match only
OPERATIONS LAYER          → Catalog/Variants (truth for price/stock/options), Orders, Cart
EVENT BUS                 → product.viewed, suggestion.shown, suggestion.clicked, order.intent
```

The engine is **additive**: the existing chat pipeline still produces the reply; the engine attaches `suggestions`. If it fails, chat degrades gracefully to a plain reply.

---

## 3. Data model

### 3.1 Structured catalog (Operations Layer — needed for accurate suggestions)
RAG product *text* is fine for matching, but suggestions need exact options/stock:
- `products`: `id, tenant_id, name, category, description, base_price, currency, image_url, active`
- `product_variants`: `id, tenant_id, product_id, sku, attributes jsonb (e.g. {size:"9",colour:"Black"}), price, stock, image_url`
- Indexes: `(tenant_id, category)`, `(tenant_id, product_id)`. Variants carry the **real** price/stock the engine and the order use.

### 3.2 Interest profile (per conversation — relational state, not RAG)
`conversation_interest`: `conversation_id, tenant_id, stage, signals jsonb, updated_at`
```
signals = {
  categories:  [{ value:"shoes", weight: 0.8, lastTurn: 14 }],
  products:    [{ productId, name, weight, lastTurn }],
  attributes:  { size: "9", colour: null },         // filled as the customer reveals them
  priceHint:   { max: 12000 } | null,
  selectedProductId: "...", selectedVariantId: null
}
stage ∈ discovery | product_interest | variant_selection | ready_to_order | post_order
```
Signals **decay** (recent turns weigh more) so the engine follows the customer's *current* direction. Later this rolls up into a per-customer profile in CRM for cross-session personalization.

### 3.3 Suggestions contract (returned with every reply)
```json
{
  "reply": "We've got a few great runners 👟",
  "suggestions": {
    "products": [
      { "productId":"p1","name":"Nike Pegasus","price":"Rs 12,000","imageUrl":"…","inStock":true }
    ],
    "quickReplies": [
      { "label":"Place order", "action":"place_order", "payload":{"variantId":"v9b"} },
      { "label":"See all shoes", "action":"browse", "payload":{"category":"shoes"} }
    ],
    "attributePrompts": [
      { "attribute":"size", "options":["7","8","9","10"] },
      { "attribute":"colour", "options":["Black","White","Blue"] }
    ]
  }
}
```
Channels render this differently (see §7). Taps post the `action`+`payload` back as the next turn.

---

## 4. Per-turn pipeline

```
inbound turn
  1. INTEREST EXTRACTION (LLM structured output, cheap):
       from the message + recent history → { intent, category, productMention,
       attributesMentioned:{size,colour}, priceHint, action }   ── NO prose
  2. UPDATE interest profile (merge + decay) → new stage
  3. CANDIDATE PRODUCTS:
       semantic match (RAG over product descriptions) ∩ catalog filter
       (category, attributes, in-stock, price ≤ hint) → top N      [exact data]
  4. NEXT-BEST-ACTION (stage machine, §5) → which actions + attribute prompts
  5. RANK candidates (§6) → final products[]
  6. REPLY COMPOSER (LLM): given the chosen products + actions, write a short,
       on-brand reply that references them. The model may only mention items
       in the candidate set (anti-hallucination).
  7. RETURN { reply, suggestions }; emit suggestion.shown
```

Two LLM calls (extract + compose) or one combined structured-output call. Steps 3–5 are deterministic so prices/stock/options are always real. The composer is told: *"You may only mention the products provided; do not invent any."*

---

## 5. Next-best-action funnel (the "interest direction" engine)

A small, explicit state machine — deterministic and debuggable (no open-ended agent):

| Stage | Trigger | Suggested actions / prompts |
|---|---|---|
| **discovery** | general/browse intent | category chips, top/featured products |
| **product_interest** | a product mentioned/tapped | that product card + similar; quick reply "Place order" |
| **variant_selection** | product selected, attributes missing | **attribute prompts** for each missing required variant attribute (size, colour) |
| **ready_to_order** | product + all attributes + in stock | "✅ Place order", "Add another", price summary |
| **post_order** | order placed | "Track order", "Pay now" (if unpaid), "Need help?" |

Required attributes per product are derived from its `product_variants.attributes` keys. The engine prompts only for **missing** ones, and offers only **in-stock** option values.

---

## 6. Ranking strategy (pluggable)
`score = w1·semanticRelevance + w2·interestMatch + w3·inStock + w4·popularity + w5·margin`
- MVP: relevance + interest-match + in-stock filter (hide out-of-stock or mark it).
- Later: popularity (from `product.viewed`/order events), margin-aware upsell, "frequently bought with."
- Strategy is an interface (`RecommendationStrategy`) so tenants/plans can swap it.

---

## 7. Channel rendering (same contract, native widgets)
| Channel | products | quickReplies | attributePrompts |
|---|---|---|---|
| **Web widget / Flutter** | product cards (image, price, CTA) | chips/buttons | option chips |
| **WhatsApp** | image + caption; **interactive list** for >3 | **interactive buttons** (≤3) or **list** (≤10) | list/buttons of options |
| **Instagram/Messenger** | generic template cards | quick replies | quick replies |

A `ChannelRenderer` per adapter maps the neutral `suggestions` object to the platform's message type, and maps taps back into a normalized inbound turn (`action`+`payload`). This keeps the engine channel-agnostic (docs/01 adapter pattern).

---

## 8. Anti-hallucination guarantees
- Candidate products/variants/prices/stock come **only** from `products`/`product_variants` (Operations) — the composer is constrained to the provided set.
- Attribute options are **only** the real in-stock variant values.
- "Place order" builds a cart/order from the selected **variantId** (a real row), not free text.
- If nothing matches, the engine suggests browsing or asks a clarifying question — it never fabricates a product.

---

## 9. Events (feed analytics + personalization)
`interest.updated · product.viewed · suggestion.shown · suggestion.clicked · order.intent_detected · cart.item_added`
→ **Analytics** (what gets suggested vs clicked, conversion funnel), → **personalization** (popularity ranking, per-customer interest in CRM). All carry `tenant_id` + `conversation_id`; consumers idempotent.

---

## 10. Multi-tenant & reliability
- Catalog, variants, interest profiles — all `tenant_id`-scoped under RLS (docs/03).
- Interest extraction/composer tools never receive tenant/customer ids from the model — injected server-side.
- The engine is **best-effort**: a failure (extraction error, empty catalog) → plain conversational reply with no suggestions. Suggestions never block or break the core answer.

---

## 11. Module shape (NestJS)
```
backend/src/conversations/suggestions/
  interest-tracker.service.ts     extract + merge/decay interest signals
  suggestion-engine.service.ts    candidates + next-best-action + rank → Suggestions
  next-best-action.ts             the stage machine (table in §5)
  recommendation.strategy.ts      ranking interface + default impl
  suggestions.types.ts            the response contract (§3.3)
backend/src/operations/catalog/   products + product_variants (truth for suggestions)
```
The chat endpoint returns `{ reply, suggestions }`; the web widget/Flutter render chips & cards; WhatsApp uses interactive messages.

---

## 12. Phased implementation
1. **Structured catalog + variants** (Operations) — the data suggestions need.
2. **InterestTracker + SuggestionEngine** returning the `suggestions` contract (products + quick replies).
3. **Web console / widget rendering** — show product cards + chips; taps drive the next turn.
4. **Attribute prompts + order funnel** (size/colour → ready_to_order → place_order via the Orders module).
5. **WhatsApp interactive messages** mapping.
6. **Analytics + personalization** from suggestion events.

> Fits cleanly on top of Phase 2: catalog/orders are relational (accurate), the engine lives in the Conversation Layer, everything is event-driven and tenant-safe. Build it **after** the Orders module so "Place order" has a real target.

*Related: [09-business-operations.md](./09-business-operations.md) · [02-ai-brain.md](./02-ai-brain.md) · [01-channels.md](./01-channels.md) · [ADR-0004](./ADR-0004-operational-data-relational.md).*
