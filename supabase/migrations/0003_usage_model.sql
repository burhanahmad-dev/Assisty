-- =============================================================================
-- Assisty — add per-model attribution to the usage ledger (model usage meter).
-- Idempotent. Safe to re-run.
-- =============================================================================

-- Which model produced this usage event (e.g. 'openai/gpt-4o-mini'). Nullable
-- for historical rows recorded before model tracking existed.
ALTER TABLE usage_ledger ADD COLUMN IF NOT EXISTS model text;

CREATE INDEX IF NOT EXISTS idx_usage_ledger_tenant_model
  ON usage_ledger (tenant_id, model);
