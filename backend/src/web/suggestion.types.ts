/**
 * The Suggestion contract returned with every chat reply.
 *
 * BUSINESS-AGNOSTIC. The engine knows nothing about any industry. The model
 * reads THIS tenant's own data (profile, knowledge base, catalog) + the
 * conversation, then PREDICTS what to surface. The relational catalog GROUNDS
 * anything purchasable (real names/prices/stock/options). For tenants with no
 * catalog (service businesses), it still returns smart next-step chips.
 */

/** A product/service card the UI renders (always backed by a real catalog row). */
export interface SuggestedProduct {
  productId: string;
  name: string;
  price: number;
  currency: string;
  inStock: boolean;
  /**
   * Arbitrary option axes for THIS item — whatever the business defined.
   * e.g. { sizes:[...], colours:[...] } for a shop, { portions:[...] } for a
   * kitchen, {} for a flat product. Never assumed to be size/colour.
   */
  options: Record<string, string[]>;
}

/** A tappable next-step chip, named by the model for THIS business. */
export interface QuickReply {
  label: string;
  action: string;
  payload?: unknown;
}

/**
 * Option chips for a detail the bot is asking about. The `attribute` is named
 * by the model in the business's own terms ("size", "party size", "plan", …).
 */
export interface AttributePrompt {
  attribute: string;
  options: string[];
}

/** The full structured suggestions object returned alongside the reply. */
export interface Suggestions {
  products: SuggestedProduct[];
  quickReplies: QuickReply[];
  attributePrompts: AttributePrompt[];
}

/** The RAW shape the model emits (before grounding/validation). */
export interface ModelSuggestion {
  /** ids from the AVAILABLE PRODUCTS list we provided (catalog-grounded). */
  productIds?: string[];
  /** Next details to ask — attribute names chosen by the model for this business. */
  attributePrompts?: Array<{ attribute?: string; options?: string[] }>;
  quickReplies?: Array<{ label?: string; action?: string; payload?: unknown }>;
  /**
   * Set ONLY after the customer explicitly confirms a purchase. The backend
   * verifies the product + inventory and places the order from the REAL catalog
   * row (the model never decides price/availability or the order number).
   */
  placeOrder?: { productId?: string; quantity?: number; options?: Record<string, string> };
}

/** What the model returns: the human-facing reply + structured suggestions. */
export interface ModelTurn {
  reply: string;
  suggestions: ModelSuggestion;
}

export const EMPTY_SUGGESTIONS: Suggestions = {
  products: [],
  quickReplies: [],
  attributePrompts: [],
};
