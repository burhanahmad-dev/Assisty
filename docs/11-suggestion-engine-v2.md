# Assisty — Suggestion Engine v2 (AI-Driven, Business-Agnostic)

> **Status:** Implemented (2026-06-14). Supersedes the regex-based suggestion logic shipped on 2026-06-02.
> **Scope of this doc:** what the engine now is, **what changed from the previous architecture**, the data contract, the per-turn flow, and every file touched. Self-contained so it can be reviewed in isolation (e.g. shared with another assistant).

---

## 0. Context (what Assisty is, in one line)

A **multi-tenant** AI customer-service + commerce platform: a business connects channels (web widget live; WhatsApp built), gives the agent its knowledge + persona, and the AI answers customers, **suggests next steps**, and takes/tracks orders. Backend = NestJS monolith; data = Supabase Postgres + pgvector; AI = Google Gemini via its OpenAI-compatible endpoint.

The three layers are unchanged:
1. **AI Conversation Layer** — channels, persona/tone, RAG retrieval, **suggestion engine**, commerce bridge.
2. **Knowledge Base Layer** — RAG over pgvector (profile, FAQ, policies, free text, website import).
3. **Business Operations Layer** — relational tables: catalog, orders, settings.

**Golden rule (unchanged):** operational data (orders, prices, stock, options) lives in **relational tables and is fetched exactly** — never invented, never RAG. Fuzzy prose lives in RAG.

---

## 1. The problem with the previous architecture

The 2026-06-02 build shipped a suggestion engine that **did not behave like a real recommendation engine**. Root causes, all in code:

| # | Problem | Where |
|---|---|---|
| 1 | **Regex, not AI.** Suggestions were triggered by hardcoded keyword regexes (`wantsOrder`, `wantsCatalog`) on the **current message only** — no conversation awareness, no prediction. | `web/commerce.service.ts` |
| 2 | **Industry-hardcoded.** Attribute prompts were derived specifically from `product.options.sizes` / `product.options.colours` — i.e. **fashion-only**. A restaurant, clinic, salon or SaaS tenant got nonsense. | `commerce.service.ts` |
| 3 | **`quickReplies` never populated.** The array was initialised and returned empty on every turn. | `commerce.service.ts` |
| 4 | **UI dropped half the output.** The console only rendered product **cards**; it ignored `quickReplies` and `attributePrompts` entirely. The widget rendered **no** suggestions at all. | `web/web.controller.ts`, `web/widget.controller.ts` |
| 5 | **No funnel / interest awareness.** No notion of conversation stage, so it couldn't ask for the *missing* detail at the right moment. | — |

**Net effect:** a static keyword matcher with a half-wired contract and a UI that discarded the predictive parts. It only "worked" for a shoe shop, and even then poorly.

### The key architectural mistake (the one that drove this rewrite)
The first redesign attempt baked the **shoes example** (size/colour, "browse → size → colour → order") directly into the engine. But Assisty is **multi-tenant** — every tenant runs a *different* business. **Hardcoding any industry is wrong.** The engine must be **business-agnostic** and derive everything from *that tenant's own data* + the conversation.

---

## 2. The new architecture (v2)

**One combined, grounded, structured LLM call per turn**, fully business-agnostic.

```
inbound turn
  1. GATHER GROUNDING (deterministic, tenant-scoped):
       - RAG retrieve  → fuzzy business knowledge (KB)
       - Commerce      → real order rows (if an order is referenced)
                       → candidate catalog rows (if the tenant has a catalog),
                         serialised with ARBITRARY option axes + their [id]
  2. BUILD PROMPT:
       persona + style + grounding rules + business info (RAG+orders+catalog)
       + a STRICT JSON output contract + the last ~10 turns of history
  3. ONE STRUCTURED CALL to the model (response_format: json_object):
       returns { reply, suggestions: { productIds, attributePrompts, quickReplies } }
  4. GROUND THE OUTPUT:
       - products: only ids that exist in the candidate set (no invention)
       - attributePrompts: kept generic, but if the attribute maps to a real
         option axis of the surfaced product, REAL option values are substituted
       - quickReplies: sanitised + capped (max 4)
  5. RETURN { reply, suggestions }  → UI renders cards + chips
```

### Why this is correct for a multi-tenant product
- **"Business understanding" comes from the tenant's OWN data** (profile, KB, catalog) — all `tenant_id`-scoped. So when a real user logs in we **never guess** their industry; we read what they configured. This is automatically per-tenant.
- **The model names its own attributes and next steps**, adapted to the business:
  - clothing shop → `size`, `colour`
  - restaurant → `party size`, `seating`, `time`
  - salon → `service`, `time`
  - software → `plan`, `team size`
  - service business with no catalog → **no product cards**, just smart quick-reply chips from the KB
- **Grounding/anti-hallucination preserved:** products/prices/stock/options come only from real catalog rows the backend handed the model (by id); order facts come only from the live order rows.
- **Graceful degradation:** if the structured call or JSON parse fails, it falls back to a plain reply with empty suggestions — chat never breaks.
- **One LLM call** (reply + suggestions together), important for the free Gemini tier's rate limits and for keeping reply/suggestions consistent.

---

## 3. The data contract

Returned with **every** chat reply (`POST /web/chat` response `suggestions` field):

```jsonc
{
  "reply": "Great choice! That one's one of our most popular 👍",
  "suggestions": {
    "products": [
      {
        "productId": "uuid",
        "name": "…",
        "price": 12000,
        "currency": "PKR",
        "inStock": true,
        "options": { "<axis>": ["…"], "…": ["…"] }   // arbitrary axes, business-defined
      }
    ],
    "attributePrompts": [
      { "attribute": "<named by the model for THIS business>", "options": ["…"] }
    ],
    "quickReplies": [
      { "label": "<short next step>", "action": "reply", "payload": null }
    ]
  }
}
```

**Raw shape the model emits** (before grounding/validation):
```jsonc
{
  "reply": "string",
  "suggestions": {
    "productIds": ["<id from the AVAILABLE PRODUCTS list>"],
    "attributePrompts": [{ "attribute": "string", "options": ["string"] }],
    "quickReplies": [{ "label": "string" }]
  }
}
```

Nothing in the contract is size/colour-specific. `options` and `attribute` are **arbitrary strings**.

---

## 4. Files changed (full list)

| File | Change |
|---|---|
| `backend/src/ai/ai.service.ts` | Added `json?: boolean` to `ChatParams`; when set, sends `response_format: { type: 'json_object' }`. Reuses the existing retry/fallback path. |
| `backend/src/web/suggestion.types.ts` | **NEW.** The generic Suggestions contract (`SuggestedProduct`, `QuickReply`, `AttributePrompt`, `Suggestions`) + the raw model shapes (`ModelSuggestion`, `ModelTurn`) + `EMPTY_SUGGESTIONS`. No industry assumptions. |
| `backend/src/web/commerce.service.ts` | Refactored from a regex **suggestion builder** into a grounded **candidate provider**. Returns `CommerceContext { contextText, candidates }`. Pulls real orders (when referenced) + catalog candidates (search → fallback to active list). Serialises **arbitrary** option axes generically (`describeOptions`), each product line prefixed with its `[id]`. |
| `backend/src/web/web-chat.service.ts` | **Core of v2.** One combined structured call returns `{ reply, suggestions }`. New `groundSuggestions()` maps model picks → real catalog rows, grounds attribute options against real axes (`matchOptionAxis`), sanitises quick replies. New `parseTurn()` tolerantly parses the model's JSON (strips code fences/prose). System prompt rewritten: business-agnostic grounding + a STRICT JSON output contract + "name attributes in the business's own words" guidance. |
| `backend/src/operations/catalog/catalog.service.ts` | `ProductRow.options` widened from `{ sizes?, colours? }` to `Record<string, string[]>` (arbitrary axes). |
| `backend/src/operations/orders/orders.service.ts` | `OrderItemInput` gains a generic `options?: Record<string,string>` bag (kept `size`/`colour` for back-compat); persisted in `create()`. |
| `backend/src/web/web.controller.ts` | `/test` console: `renderSuggestions()` now renders **generic product cards** (one `<select>` per option axis) **+ attribute chips + quick-reply chips**; chips send the next turn. `send(preset)` refactor so chips can drive a turn; `placeOrder(p, options)` sends a generic options bag. Fixed the Send-button handler to not leak its click event into `send()`. |
| `backend/src/web/widget.controller.ts` | Embeddable `widget.js` now renders suggestions (product/attribute/quick-reply chips) — previously it showed only the reply text. Added `.asy-chip` CSS; `send()` → `sendMsg(preset)`. |

No database migration was required (the catalog `options` column is already `jsonb`; the order `items` column is already `jsonb`).

---

## 5. Example: same engine, different businesses

**Shoe shop**
```
Customer: "I need running shoes"
Bot: "We've got a couple of great runners 👟"  + cards [Nike Pegasus] [Adidas Ultra]  + chip [See all shoes]
Customer taps Nike Pegasus
Bot: "Nice pick! What size?"  + chips [7][8][9][10]  + [See colours]
```

**Restaurant** (same code, no changes)
```
Customer: "table for tonight?"
Bot: "Sure! How many people?"  + chips [2][3][4][5+]  + [Indoor] [Outdoor]
```

**SaaS** (same code)
```
Customer: "which plan should I get?"
Bot: "Depends on your team size — happy to help you pick."  + chips [Starter] [Pro] [Enterprise]  + [See pricing] [Talk to sales]
```

The engine code is identical; only the tenant's data + the model's analysis differ.

---

## 6. What is intentionally NOT in v2 (future "Option B")

The full design (`docs/10-suggestion-engine.md`) describes a heavier engine. These were deferred to keep v2 low-risk:
- **Persistent interest profile** (`conversation_interest` table) with signal decay across turns. v2 relies on the model reading raw history instead.
- **Explicit next-best-action state machine** as code. v2 expresses the funnel as prompt guidance.
- **Ranking strategy** (popularity/margin) and **suggestion analytics events** (`suggestion.shown/clicked`).
- **WhatsApp interactive-message mapping** of the same contract (v2 wires the web console + widget only).

These layer on top of v2 without rework, because the `suggestions` contract is already the neutral, channel-agnostic shape they target.

---

## 7. Known constraints (unchanged platform-level gaps)

These are not introduced by v2 but are relevant when reviewing it:
- **Single-tenant in practice today:** tenant is resolved as "the first tenant" (no auth yet). The engine is written tenant-scoped, so it becomes correct automatically once auth/multi-tenancy lands.
- **Free Gemini tier rate limits** can cause occasional fallback replies (mitigated by the existing model fallback + the single-call design).
- **Local run requires** `backend/.env` with `DATABASE_URL` (Supabase) and `LITELLM_BASE_URL` + `LITELLM_API_KEY` (Gemini).

---

*Related: `docs/10-suggestion-engine.md` (original design), `docs/09-business-operations.md`, `ARCHITECTURE.md`.*
