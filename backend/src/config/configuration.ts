import { envSchema, type Env } from './env.validation';

/**
 * Typed, nested application configuration object.
 * Read via ConfigService.get('namespace', { infer: true }).
 */
export interface AppConfig {
  env: Env['NODE_ENV'];
  port: number;
  logLevel: string;
  isProduction: boolean;
  database: {
    url: string;
  };
  /** Supabase Auth — operator login + JWT verification. */
  auth: {
    supabaseUrl: string;
    supabaseAnonKey: string;
    /** Legacy HS256 secret; when absent we verify via the project JWKS. */
    jwtSecret?: string;
  };
  litellm: {
    baseUrl: string;
    apiKey: string;
  };
  /** Optional OpenRouter chat gateway. When apiKey is set, chat uses this; embeddings stay on litellm. */
  openrouter: {
    baseUrl: string;
    apiKey: string;
  };
  ai: {
    defaultChatModel: string;
    /** Optional OpenRouter fallback models (auto-route around throttled ones). */
    fallbackChatModels: string[];
    embeddingModel: string;
    embeddingDim: number;
  };
  whatsapp: {
    verifyToken: string;
    appSecret: string;
    graphVersion: string;
    /** When true, sendText logs the reply instead of calling the Graph API. */
    dryRun: boolean;
    /** Single-tenant dev fallback only; real tokens live in channel_connections. */
    accessToken?: string;
    phoneNumberId?: string;
  };
}

/**
 * ConfigModule `load` factory. Re-parses process.env through the same zod
 * schema (cheap, deterministic) so defaults/coercions are applied, then maps
 * the flat env into the nested AppConfig shape.
 */
export default function configuration(): AppConfig {
  const env = envSchema.parse(process.env);

  const fallbackChatModels = (env.FALLBACK_CHAT_MODELS ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0);

  return {
    env: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    isProduction: env.NODE_ENV === 'production',
    database: {
      url: env.DATABASE_URL,
    },
    auth: {
      supabaseUrl: env.SUPABASE_URL,
      supabaseAnonKey: env.SUPABASE_ANON_KEY,
      jwtSecret: env.SUPABASE_JWT_SECRET,
    },
    litellm: {
      baseUrl: env.LITELLM_BASE_URL,
      apiKey: env.LITELLM_API_KEY,
    },
    openrouter: {
      baseUrl: env.OPENROUTER_BASE_URL,
      apiKey: env.OPENROUTER_API_KEY ?? '',
    },
    ai: {
      defaultChatModel: env.DEFAULT_CHAT_MODEL,
      fallbackChatModels,
      embeddingModel: env.EMBEDDING_MODEL,
      embeddingDim: env.EMBEDDING_DIM,
    },
    whatsapp: {
      verifyToken: env.WHATSAPP_VERIFY_TOKEN,
      appSecret: env.WHATSAPP_APP_SECRET,
      graphVersion: env.WHATSAPP_GRAPH_VERSION,
      dryRun: env.WHATSAPP_DRY_RUN,
      accessToken: env.WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    },
  };
}
