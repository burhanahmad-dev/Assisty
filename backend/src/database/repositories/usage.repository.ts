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
   * Append a usage event to the ledger (e.g. kind "ai_tokens", "messages").
   * Append-only by design — aggregation/billing happens downstream.
   */
  async record(tenantId: string, kind: string, amount: number): Promise<void> {
    await this.db.sql`
      INSERT INTO usage_ledger (tenant_id, kind, amount)
      VALUES (${tenantId}, ${kind}, ${amount})
    `;
  }
}
