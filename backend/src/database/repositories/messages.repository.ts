import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';

export interface MessageRow {
  id: string;
  tenantId: string;
  conversationId: string;
  direction: 'inbound' | 'outbound';
  role: string;
  channelMessageId: string | null;
  content: string;
  model: string | null;
  tokens: number | null;
  createdAt: Date;
}

export interface InsertInboundInput {
  tenantId: string;
  conversationId: string;
  channelMessageId: string;
  content: string;
}

export interface InsertOutboundInput {
  tenantId: string;
  conversationId: string;
  content: string;
  model: string;
  tokens: number;
}

@Injectable()
export class MessagesRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Idempotency guard for inbound webhooks: returns true if a message with the
   * given provider message id (wamid) has already been persisted. Backed by the
   * partial UNIQUE index on channel_message_id.
   */
  async existsByChannelMessageId(channelMessageId: string): Promise<boolean> {
    const rows = await this.db.sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM messages WHERE channel_message_id = ${channelMessageId}
      ) AS "exists"
    `;
    return rows[0]?.exists ?? false;
  }

  /**
   * Persist an inbound message. IDEMPOTENT: a pg-boss retry (or a duplicate that
   * slipped past webhook_events) will not create a second row, thanks to the
   * partial UNIQUE index on channel_message_id. Returns the inserted row, or
   * null when it already existed (conflict) — callers may ignore the result.
   */
  async insertInbound(input: InsertInboundInput): Promise<MessageRow | null> {
    const rows = await this.db.sql<MessageRow[]>`
      INSERT INTO messages
        (tenant_id, conversation_id, direction, role, channel_message_id, content)
      VALUES
        (${input.tenantId}, ${input.conversationId}, 'inbound', 'user',
         ${input.channelMessageId}, ${input.content})
      ON CONFLICT (channel_message_id) WHERE channel_message_id IS NOT NULL
        DO NOTHING
      RETURNING
        id,
        tenant_id          AS "tenantId",
        conversation_id    AS "conversationId",
        direction,
        role,
        channel_message_id AS "channelMessageId",
        content,
        model,
        tokens,
        created_at         AS "createdAt"
    `;
    return rows[0] ?? null;
  }

  async insertOutbound(input: InsertOutboundInput): Promise<MessageRow> {
    const rows = await this.db.sql<MessageRow[]>`
      INSERT INTO messages
        (tenant_id, conversation_id, direction, role, content, model, tokens)
      VALUES
        (${input.tenantId}, ${input.conversationId}, 'outbound', 'assistant',
         ${input.content}, ${input.model}, ${input.tokens})
      RETURNING
        id,
        tenant_id          AS "tenantId",
        conversation_id    AS "conversationId",
        direction,
        role,
        channel_message_id AS "channelMessageId",
        content,
        model,
        tokens,
        created_at         AS "createdAt"
    `;
    return rows[0];
  }

  /**
   * Most recent messages for a conversation, returned OLDEST -> NEWEST so the
   * caller can feed them straight into the LLM as chat history.
   */
  async recentByConversation(
    conversationId: string,
    limit: number,
  ): Promise<MessageRow[]> {
    const rows = await this.db.sql<MessageRow[]>`
      SELECT * FROM (
        SELECT
          id,
          tenant_id          AS "tenantId",
          conversation_id    AS "conversationId",
          direction,
          role,
          channel_message_id AS "channelMessageId",
          content,
          model,
          tokens,
          created_at         AS "createdAt"
        FROM messages
        WHERE conversation_id = ${conversationId}
        ORDER BY created_at DESC
        LIMIT ${limit}
      ) recent
      ORDER BY recent."createdAt" ASC
    `;
    return rows;
  }
}
