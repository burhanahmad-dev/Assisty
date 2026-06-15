import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

/**
 * Maps an authenticated Supabase user (sub) to their tenant.
 *
 * Model (per ADR-0003): one operator ↔ one tenant. On first login the operator
 * has no `users` row yet, so we bootstrap a fresh tenant + owner user. This is
 * the single source of tenant identity — it replaces every old
 * `resolveTenant()` = "first tenant" call.
 *
 * NOTE (P2/RLS): once RLS is enabled, this lookup runs via a SECURITY DEFINER
 * function so it can resolve the tenant *before* tenant context exists.
 */
@Injectable()
export class TenantResolverService {
  private readonly logger = new Logger(TenantResolverService.name);

  constructor(private readonly db: DatabaseService) {}

  async resolveOrBootstrap(sub: string, email?: string): Promise<string> {
    const existing = await this.db.sql<{ tenant_id: string }[]>`
      SELECT tenant_id FROM users WHERE supabase_uid = ${sub} LIMIT 1
    `;
    if (existing[0]) return existing[0].tenant_id;

    // First login for this operator → provision their tenant.
    const name = email ? email.split('@')[0] : 'New Business';
    const created = await this.db.sql<{ id: string }[]>`
      INSERT INTO tenants (name) VALUES (${name}) RETURNING id
    `;
    const tenantId = created[0].id;
    await this.db.sql`
      INSERT INTO users (tenant_id, email, supabase_uid, role)
      VALUES (${tenantId}, ${email ?? null}, ${sub}, 'owner')
      ON CONFLICT (supabase_uid) DO NOTHING
    `;
    this.logger.log({ msg: 'tenant.bootstrapped', tenantId, sub });
    return tenantId;
  }
}
