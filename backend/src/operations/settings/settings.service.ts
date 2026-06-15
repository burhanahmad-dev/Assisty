import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

export interface TenantSettings {
  /** Order statuses from which a cancellation is allowed. */
  cancellableStatuses: string[];
  /** Whether a customer (via chat) may cancel, or only the operator. */
  allowCustomerCancel: boolean;
  /** Default currency for new orders. */
  currency: string;
  /** Auto-confirm new orders (skip the 'pending' review step). */
  autoConfirmOrders: boolean;
  /** Selected chat model id (OpenRouter format). Empty string = use the system default. */
  model: string;
}

const DEFAULTS: TenantSettings = {
  cancellableStatuses: ['pending', 'confirmed', 'processing'],
  allowCustomerCancel: false,
  currency: 'PKR',
  autoConfirmOrders: false,
  model: '',
};

@Injectable()
export class SettingsService {
  constructor(private readonly db: DatabaseService) {}

  async get(tenantId: string): Promise<TenantSettings> {
    const rows = await this.db.scoped(tenantId, (sql) =>
      sql<{ settings: Partial<TenantSettings> }[]>`
        SELECT settings FROM tenant_settings WHERE tenant_id = ${tenantId}
      `,
    );
    return { ...DEFAULTS, ...(rows[0]?.settings ?? {}) };
  }

  async set(tenantId: string, partial: Partial<TenantSettings>): Promise<TenantSettings> {
    const merged = { ...(await this.get(tenantId)), ...partial };
    await this.db.scoped(tenantId, (sql) =>
      sql`
        INSERT INTO tenant_settings (tenant_id, settings, updated_at)
        VALUES (${tenantId}, ${sql.json(merged)}, now())
        ON CONFLICT (tenant_id) DO UPDATE SET settings = ${sql.json(merged)}, updated_at = now()
      `,
    );
    return merged;
  }
}
