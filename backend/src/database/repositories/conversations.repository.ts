import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';

export interface ConversationRow {
  id: string;
  tenantId: string;
  channelConnectionId: string;
  customerExternalId: string;
  status: string;
  lastMessageAt: Date | null;
  createdAt: Date;
}

@Injectable()
export class ConversationsRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Get the existing open conversation for (channel_connection, customer) or
   * create one. Relies on the UNIQUE(channel_connection_id, customer_external_id)
   * constraint with ON CONFLICT to stay race-safe under concurrent webhooks.
   *
   * Tenant scoping: tenant_id is written on insert and re-asserted on read so
   * a connection can never bleed conversations across tenants.
   */
  async findOrCreate(
    tenantId: string,
    channelConnectionId: string,
    customerExternalId: string,
  ): Promise<ConversationRow> {
    const rows = await this.db.sql<ConversationRow[]>`
      INSERT INTO conversations
        (tenant_id, channel_connection_id, customer_external_id, status, last_message_at)
      VALUES
        (${tenantId}, ${channelConnectionId}, ${customerExternalId}, 'open', now())
      ON CONFLICT (channel_connection_id, customer_external_id)
      DO UPDATE SET last_message_at = now()
      RETURNING
        id,
        tenant_id             AS "tenantId",
        channel_connection_id AS "channelConnectionId",
        customer_external_id  AS "customerExternalId",
        status,
        last_message_at       AS "lastMessageAt",
        created_at            AS "createdAt"
    `;
    return rows[0];
  }

  /** Bump last_message_at to keep conversation ordering fresh. */
  async touch(id: string): Promise<void> {
    await this.db.sql`
      UPDATE conversations
      SET last_message_at = now()
      WHERE id = ${id}
    `;
  }
}
