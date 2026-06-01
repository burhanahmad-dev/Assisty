-- =============================================================================
-- Assisty MVP — initial schema
-- Idempotent (IF NOT EXISTS everywhere). Safe to run repeatedly.
-- pg-boss creates and manages its own schema on boot — do NOT define it here.
-- =============================================================================

-- Extensions ------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;     -- pgvector: embeddings
CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- gen_random_uuid()

-- Tenants ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Users -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  email        text,
  supabase_uid text UNIQUE,
  role         text NOT NULL DEFAULT 'owner',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON users (tenant_id);

-- Channel connections ---------------------------------------------------------
-- Per-tenant inbound/outbound channels. WhatsApp access tokens + phone_number_id
-- live here (NOT env) so one deployment can serve many tenants.
CREATE TABLE IF NOT EXISTS channel_connections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  type            text NOT NULL CHECK (
                    type IN ('whatsapp', 'web', 'email', 'messenger', 'instagram', 'tiktok')
                  ),
  external_id     text,
  access_token    text,
  phone_number_id text,
  status          text NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (type, external_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_connections_tenant_id
  ON channel_connections (tenant_id);

-- Conversations ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  channel_connection_id uuid NOT NULL REFERENCES channel_connections (id) ON DELETE CASCADE,
  customer_external_id  text NOT NULL,
  status                text NOT NULL DEFAULT 'open',
  last_message_at       timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_connection_id, customer_external_id)
);
CREATE INDEX IF NOT EXISTS idx_conversations_tenant_id
  ON conversations (tenant_id);

-- Messages --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  conversation_id    uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  direction          text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  role               text,
  channel_message_id text,
  content            text,
  model              text,
  tokens             int,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_tenant_id
  ON messages (tenant_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
  ON messages (conversation_id);
-- Idempotency: a provider message id (wamid) may appear at most once. Partial
-- so outbound messages (no channel_message_id) are unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_channel_message_id
  ON messages (channel_message_id)
  WHERE channel_message_id IS NOT NULL;

-- Knowledge base documents ----------------------------------------------------
CREATE TABLE IF NOT EXISTS kb_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  type         text,
  title        text,
  source       text,
  status       text NOT NULL DEFAULT 'approved',
  content      text,
  content_hash text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kb_documents_tenant_id
  ON kb_documents (tenant_id);

-- Knowledge base chunks (embeddings) ------------------------------------------
-- Embedding dim is pinned to 1536 (text-embedding-3-small). Changing the model
-- to a different dim requires a migration.
CREATE TABLE IF NOT EXISTS kb_chunks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES kb_documents (id) ON DELETE CASCADE,
  content     text NOT NULL,
  embedding   vector(1536),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_tenant_id
  ON kb_chunks (tenant_id);
-- ANN index for cosine similarity search.
CREATE INDEX IF NOT EXISTS idx_kb_chunks_embedding
  ON kb_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Usage ledger ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_ledger (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  kind       text NOT NULL,
  amount     numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_tenant_id
  ON usage_ledger (tenant_id);

-- Webhook events (ingest-side idempotency) ------------------------------------
CREATE TABLE IF NOT EXISTS webhook_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    text NOT NULL,
  event_id    text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);
