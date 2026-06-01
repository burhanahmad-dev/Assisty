/**
 * AI model registry + resolution helpers.
 *
 * Model ids below MUST match entries in infra/litellm/config.yaml.
 * LiteLLM is the single gateway; the backend only ever talks OpenAI-shaped
 * requests to LITELLM_BASE_URL and never to a provider directly.
 *
 * Adding a new provider/model (e.g. Anthropic Claude) is a CONFIG-ONLY change:
 * add one entry to infra/litellm/config.yaml under model_list and reference the
 * model id here. No code change is required to route to a new provider.
 */

/** Chat model ids known to the gateway (must exist in litellm config.yaml). */
export const ChatModels = {
  GPT_4O_MINI: 'gpt-4o-mini',
  GEMINI_1_5_FLASH: 'gemini-1.5-flash',
  OPENROUTER_GPT_4O_MINI: 'openrouter/openai/gpt-4o-mini',
} as const;

export type ChatModelId = (typeof ChatModels)[keyof typeof ChatModels];

/** Embedding model ids known to the gateway (must exist in litellm config.yaml). */
export const EmbeddingModels = {
  TEXT_EMBEDDING_3_SMALL: 'text-embedding-3-small',
} as const;

export type EmbeddingModelId =
  (typeof EmbeddingModels)[keyof typeof EmbeddingModels];

/** Set of valid chat model ids for quick membership checks. */
const KNOWN_CHAT_MODELS = new Set<string>(Object.values(ChatModels));

/**
 * Resolve which chat model to use for a request.
 *
 * @param requested  Caller-requested model id (optional).
 * @param fallback   The configured DEFAULT_CHAT_MODEL.
 * @returns          The requested model if known, otherwise the configured default.
 */
export function resolveChatModel(
  requested: string | undefined,
  fallback: string,
): string {
  if (requested && KNOWN_CHAT_MODELS.has(requested)) {
    return requested;
  }
  return fallback;
}
