import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';

export interface UsageRow {
  id: string;
  tenantId: string;
  kind: string;
  amount: string;
  createdAt: Date;
}

@Injectable()
export class UsageRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Append a usage event to the ledger (e.g. kind "ai_tokens", "messages"),
   * attributed to the model that produced it. Append-only by design.
   */
  async record(
    tenantId: string,
    kind: string,
    amount: number,
    model?: string,
  ): Promise<void> {
    await this.db.scoped(tenantId, async (sql) => {
      await sql`
        INSERT INTO usage_ledger (tenant_id, kind, amount, model)
        VALUES (${tenantId}, ${kind}, ${amount}, ${model ?? null})
      `;
    });
  }

  /**
   * Per-model usage totals for a tenant — powers the model usage meter.
   * Returns one row per model with summed tokens + message counts.
   */
  async byModel(
    tenantId: string,
  ): Promise<Array<{ model: string; tokens: number; messages: number }>> {
    const rows = await this.db.scoped(tenantId, (sql) => sql<
      { model: string; tokens: string; messages: string }[]
    >`
      SELECT COALESCE(NULLIF(model, ''), 'default / untracked') AS model,
             COALESCE(SUM(amount) FILTER (WHERE kind = 'ai_tokens'), 0)::bigint AS tokens,
             COALESCE(SUM(amount) FILTER (WHERE kind = 'messages'), 0)::bigint AS messages
      FROM usage_ledger
      WHERE tenant_id = ${tenantId}
      GROUP BY COALESCE(NULLIF(model, ''), 'default / untracked')
      ORDER BY tokens DESC
    `);
    return rows.map((r) => ({
      model: r.model,
      tokens: Number(r.tokens),
      messages: Number(r.messages),
    }));
  }
}
