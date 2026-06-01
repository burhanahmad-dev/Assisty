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

  // LiteLLM proxy (OpenAI-compatible)
  LITELLM_BASE_URL: z.string().min(1, 'LITELLM_BASE_URL is required'),
  LITELLM_API_KEY: z.string().min(1, 'LITELLM_API_KEY is required'),

  // AI models
  DEFAULT_CHAT_MODEL: z.string().default('gpt-4o-mini'),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  EMBEDDING_DIM: z.coerce.number().int().positive().default(1536),

  // WhatsApp (Meta Cloud API)
  WHATSAPP_VERIFY_TOKEN: z.string().min(1, 'WHATSAPP_VERIFY_TOKEN is required'),
  WHATSAPP_APP_SECRET: z.string().min(1, 'WHATSAPP_APP_SECRET is required'),
  WHATSAPP_GRAPH_VERSION: z.string().default('v21.0'),

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
