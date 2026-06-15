-- =============================================================================
-- Assisty — product SKU / code (from spreadsheet import). Idempotent.
-- Kept queryable (not encrypted) so the AI can ground "do you have code X?".
-- Tenant isolation is enforced by the existing products RLS policy.
-- =============================================================================

ALTER TABLE products ADD COLUMN IF NOT EXISTS sku text;
CREATE INDEX IF NOT EXISTS idx_products_tenant_sku ON products (tenant_id, sku);
