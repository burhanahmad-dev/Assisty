import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';

/**
 * A resolved channel connection. `accessToken` / `phoneNumberId` are per-tenant
 * WhatsApp credentials stored in the DB (NOT env) so a single deployment can
 * serve many tenants.
 */
export interface ChannelConnectionRow {
  id: string;
  tenantId: string;
  type: string;
  externalId: string;
  accessToken: string | null;
  phoneNumberId: string | null;
  status: string;
}

@Injectable()
export class ChannelConnectionsRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Resolve a connection by its provider-side identifier. For WhatsApp the
   * `externalId` is the phone_number_id reported in the webhook metadata.
   */
  async findByExternalId(
    type: string,
    externalId: string,
  ): Promise<ChannelConnectionRow | null> {
    const rows = await this.db.sql<ChannelConnectionRow[]>`
      SELECT
        id,
        tenant_id        AS "tenantId",
        type,
        external_id      AS "externalId",
        access_token     AS "accessToken",
        phone_number_id  AS "phoneNumberId",
        status
      FROM channel_connections
      WHERE type = ${type}
        AND external_id = ${externalId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<ChannelConnectionRow | null> {
    const rows = await this.db.sql<ChannelConnectionRow[]>`
      SELECT
        id,
        tenant_id        AS "tenantId",
        type,
        external_id      AS "externalId",
        access_token     AS "accessToken",
        phone_number_id  AS "phoneNumberId",
        status
      FROM channel_connections
      WHERE id = ${id}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }
}
