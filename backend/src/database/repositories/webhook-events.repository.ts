import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';

@Injectable()
export class WebhookEventsRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Atomically claim a webhook event for first-time processing.
   *
   * Uses INSERT ... ON CONFLICT DO NOTHING against UNIQUE(provider, event_id).
   * RETURNING only yields a row when the INSERT actually happened, so:
   *   - returns true  => this is the FIRST time we've seen (provider, event_id)
   *   - returns false => duplicate; caller should skip.
   *
   * This is the primary ingest-side idempotency guard for webhooks; the
   * messages.channel_message_id unique index is the secondary guard at
   * processing time.
   */
  async tryClaim(provider: string, eventId: string): Promise<boolean> {
    const rows = await this.db.sql<{ id: string }[]>`
      INSERT INTO webhook_events (provider, event_id)
      VALUES (${provider}, ${eventId})
      ON CONFLICT (provider, event_id) DO NOTHING
      RETURNING id
    `;
    return rows.length > 0;
  }
}
