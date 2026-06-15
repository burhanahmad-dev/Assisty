/**
 * AI model registry + resolution helpers.
 *
 * CHAT models route through the configured chat gateway. When OpenRouter is
 * enabled (OPENROUTER_API_KEY set), these OpenRouter model ids expose Gemini,
 * OpenAI and DeepSeek behind one OpenAI-compatible endpoint. The operator picks
 * one per tenant in the console (Settings -> Model); it's stored in
 * tenant_settings and passed to AiService.chat per turn.
 *
 * Embeddings do NOT go through here (OpenRouter has no embeddings endpoint) —
 * they always use the LITELLM_* endpoint (Gemini gemini-embedding-001).
 */

export interface ChatModelOption {
  /** Provider-prefixed id sent to the gateway (OpenRouter format). */
  id: string;
  /** Human label shown in the selector. */
  label: string;
  /** Provider group for the dropdown. */
  provider: 'Google' | 'OpenAI' | 'DeepSeek';
}

/**
 * Curated selectable chat models (OpenRouter ids). Edit freely — adding a model
 * is a one-line change here and it appears in the selector. OpenRouter also has
 * free variants (e.g. ":free" suffixes) you can add.
 */
export const CHAT_MODEL_CATALOG: ChatModelOption[] = [
  // --- Google Gemini ---
  { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash — fast & cheap', provider: 'Google' },
  { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro — most capable', provider: 'Google' },
  { id: 'google/gemini-2.0-flash-001', label: 'Gemini 2.0 Flash', provider: 'Google' },
  // --- OpenAI ---
  { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini — fast & cheap', provider: 'OpenAI' },
  { id: 'openai/gpt-4o', label: 'GPT-4o — capable', provider: 'OpenAI' },
  { id: 'openai/gpt-4.1-mini', label: 'GPT-4.1 mini', provider: 'OpenAI' },
  // --- DeepSeek ---
  { id: 'deepseek/deepseek-chat', label: 'DeepSeek V3 — chat', provider: 'DeepSeek' },
  { id: 'deepseek/deepseek-r1', label: 'DeepSeek R1 — reasoning', provider: 'DeepSeek' },
];

/** Fallback when neither the tenant nor the env default specifies a model. */
export const DEFAULT_CATALOG_MODEL = 'google/gemini-2.5-flash';

const KNOWN_CHAT_MODELS = new Set<string>(CHAT_MODEL_CATALOG.map((m) => m.id));

/** True if the id is one of the curated selectable models. */
export function isKnownChatModel(id: string | undefined): boolean {
  return !!id && KNOWN_CHAT_MODELS.has(id);
}

/**
 * Resolve which chat model to use for a request.
 *
 * Permissive by design: the per-request model (from the tenant's selection) is
 * used as-is when provided, otherwise the configured DEFAULT_CHAT_MODEL. The
 * gateway (OpenRouter / Gemini) validates the id; the selector only ever offers
 * catalog ids, so an invalid id should not occur in normal flows.
 */
export function resolveChatModel(
  requested: string | undefined,
  fallback: string,
): string {
  if (requested && requested.trim()) return requested.trim();
  if (fallback && fallback.trim()) return fallback.trim();
  return DEFAULT_CATALOG_MODEL;
}
