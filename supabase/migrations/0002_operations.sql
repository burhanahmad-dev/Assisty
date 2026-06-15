-- =============================================================================
-- Assisty — Operations Layer: structured catalog, orders, tenant settings.
-- Relational (NOT RAG). Idempotent. Safe to re-run.
-- =============================================================================

-- Human-facing order numbers (global sequence; uniqueness still per-tenant).
CREATE SEQUENCE IF NOT EXISTS order_number_seq START 1001;

-- Catalog -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name        text NOT NULL,
  category    text,
  description text,
  price       numeric(12,2) NOT NULL DEFAULT 0,
  currency    text NOT NULL DEFAULT 'PKR',
  stock       int NOT NULL DEFAULT 0,
  options     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { sizes:[], colours:[] }
  image_url   text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_products_tenant ON products (tenant_id);
CREATE INDEX IF NOT EXISTS idx_products_tenant_category ON products (tenant_id, category);

-- Orders --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  order_number     text NOT NULL DEFAULT nextval('order_number_seq')::text,
  customer_ref     text,                      -- channel session / phone
  customer_name    text,
  status           text NOT NULL DEFAULT 'pending',
  payment_status   text NOT NULL DEFAULT 'unpaid',
  tracking_number  text,
  carrier          text,
  shipping_address text,
  items            jsonb NOT NULL DEFAULT '[]'::jsonb,
  subtotal         numeric(12,2) NOT NULL DEFAULT 0,
  total            numeric(12,2) NOT NULL DEFAULT 0,
  currency         text NOT NULL DEFAULT 'PKR',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, order_number)
);
CREATE INDEX IF NOT EXISTS idx_orders_tenant ON orders (tenant_id);
CREATE INDEX IF NOT EXISTS idx_orders_tenant_status ON orders (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_tenant_customer ON orders (tenant_id, customer_ref);

-- Per-tenant settings (cancellation policy, currency, etc.) ------------------
CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id  uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  settings   jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
