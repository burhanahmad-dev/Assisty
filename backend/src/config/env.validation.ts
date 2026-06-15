import { z } from 'zod';

/**
 * Zod schema that parses and validates process.env at boot.
 * Throws (and crashes the app) if any required variable is missing/invalid.
 * Defaults are applied here so configuration.ts can rely on coerced values.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // Database (postgres.js connection string)
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Supabase Auth — operator login. JWTs are verified against the project JWKS
  // (asymmetric, handles rotation); SUPABASE_JWT_SECRET is only for legacy HS256.
  SUPABASE_URL: z.string().min(1, 'SUPABASE_URL is required'),
  SUPABASE_ANON_KEY: z.string().min(1, 'SUPABASE_ANON_KEY is required'),
  SUPABASE_JWT_SECRET: z.string().optional(),

  // LiteLLM proxy (OpenAI-compatible) — also used as the EMBEDDINGS endpoint (Gemini).
  LITELLM_BASE_URL: z.string().min(1, 'LITELLM_BASE_URL is required'),
  LITELLM_API_KEY: z.string().min(1, 'LITELLM_API_KEY is required'),

  // OpenRouter (optional) — unified gateway for Gemini/OpenAI/DeepSeek CHAT models.
  // When OPENROUTER_API_KEY is set, chat routes through OpenRouter; embeddings
  // still use LITELLM_* (OpenRouter has no embeddings endpoint).
  OPENROUTER_BASE_URL: z.string().default('https://openrouter.ai/api/v1'),
  OPENROUTER_API_KEY: z.string().optional(),

  // AI models
  DEFAULT_CHAT_MODEL: z.string().default('gpt-4o-mini'),
  // Optional comma-separated OpenRouter fallback models (auto-route around a
  // throttled/unavailable primary — very helpful on the free tier).
  FALLBACK_CHAT_MODELS: z.string().optional(),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  EMBEDDING_DIM: z.coerce.number().int().positive().default(1536),

  // WhatsApp (Meta Cloud API)
  WHATSAPP_VERIFY_TOKEN: z.string().min(1, 'WHATSAPP_VERIFY_TOKEN is required'),
  WHATSAPP_APP_SECRET: z.string().min(1, 'WHATSAPP_APP_SECRET is required'),
  WHATSAPP_GRAPH_VERSION: z.string().default('v21.0'),

  // Local-testing toggle: when 'true'/'1', WhatsApp sends are LOGGED instead of
  // calling the Graph API, so the full loop runs without a real number.
  WHATSAPP_DRY_RUN: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),

  // Optional single-tenant dev fallbacks (per-tenant values live in DB).
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validator passed to ConfigModule.forRoot({ validate }).
 * Receives the raw env record, returns the parsed+typed object.
 * On failure it throws a readable aggregated error so the container
 * fails fast instead of running with a broken config.
 */
export function validate(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
