import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { CryptoService } from '../../crypto/crypto.service';

/**
 * A resolved channel connection. `accessToken` is stored ENCRYPTED at rest
 * (AES-256-GCM, per-tenant key) and decrypted here on read, so callers always
 * see plaintext while the DB only ever holds ciphertext.
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

export interface CreateChannelConnectionInput {
  type: string;
  externalId: string;
  accessToken?: string | null;
  phoneNumberId?: string | null;
  status?: string;
}

@Injectable()
export class ChannelConnectionsRepository {
  constructor(
    private readonly db: DatabaseService,
    private readonly crypto: CryptoService,
  ) {}

  private decryptRow(row: ChannelConnectionRow | undefined): ChannelConnectionRow | null {
    if (!row) return null;
    row.accessToken = this.crypto.decryptNullable(row.tenantId, row.accessToken);
    return row;
  }

  /**
   * Resolve a connection by its provider-side identifier (e.g. WhatsApp
   * phone_number_id). Resolution path — admin connection (no tenant context yet).
   */
  async findByExternalId(type: string, externalId: string): Promise<ChannelConnectionRow | null> {
    const rows = await this.db.sql<ChannelConnectionRow[]>`
      SELECT id, tenant_id AS "tenantId", type, external_id AS "externalId",
             access_token AS "accessToken", phone_number_id AS "phoneNumberId", status
      FROM channel_connections
      WHERE type = ${type} AND external_id = ${externalId}
      LIMIT 1
    `;
    return this.decryptRow(rows[0]);
  }

  /** Tenant-scoped: the connection must belong to the resolved tenant. */
  async findById(tenantId: string, id: string): Promise<ChannelConnectionRow | null> {
    const row = await this.db.scoped(tenantId, async (sql) => {
      const rows = await sql<ChannelConnectionRow[]>`
        SELECT id, tenant_id AS "tenantId", type, external_id AS "externalId",
               access_token AS "accessToken", phone_number_id AS "phoneNumberId", status
        FROM channel_connections
        WHERE id = ${id}
        LIMIT 1
      `;
      return rows[0];
    });
    return this.decryptRow(row);
  }

  /**
   * Create/upsert a connection with the access token ENCRYPTED at rest. Used by
   * channel onboarding (WhatsApp/Messenger/Instagram). Returns the row with the
   * token decrypted for immediate use.
   */
  async create(tenantId: string, input: CreateChannelConnectionInput): Promise<ChannelConnectionRow> {
    const encToken = this.crypto.encryptNullable(tenantId, input.accessToken ?? null);
    const row = await this.db.scoped(tenantId, async (sql) => {
      const rows = await sql<ChannelConnectionRow[]>`
        INSERT INTO channel_connections (tenant_id, type, external_id, access_token, phone_number_id, status)
        VALUES (${tenantId}, ${input.type}, ${input.externalId ?? null}, ${encToken},
                ${input.phoneNumberId ?? null}, ${input.status ?? 'active'})
        ON CONFLICT (type, external_id) DO UPDATE SET
          access_token = EXCLUDED.access_token,
          phone_number_id = EXCLUDED.phone_number_id,
          status = EXCLUDED.status
        RETURNING id, tenant_id AS "tenantId", type, external_id AS "externalId",
                  access_token AS "accessToken", phone_number_id AS "phoneNumberId", status
      `;
      return rows[0];
    });
    return this.decryptRow(row) as ChannelConnectionRow;
  }
}
