/**
 * Minimal channel abstraction for the Assisty MVP.
 *
 * Deliberately ONE interface for a normalized inbound message plus the pg-boss
 * job payload it produces. We do NOT over-abstract: every channel adapter
 * (WhatsApp today; web/email/messenger/instagram/tiktok later) parses its
 * provider-specific webhook into `NormalizedInboundMessage`, and the controller
 * enqueues an `InboundJobData` for the deterministic brain to process.
 */

/** The set of channel types supported by the platform (mirrors the DB check). */
export type ChannelType =
  | 'whatsapp'
  | 'web'
  | 'email'
  | 'messenger'
  | 'instagram'
  | 'tiktok';

/**
 * A single inbound customer message, already resolved to a tenant + channel
 * connection and normalized to a channel-agnostic shape. `raw` keeps the
 * original provider payload fragment for debugging / future enrichment.
 */
export interface NormalizedInboundMessage {
  /** Owning tenant (resolved from the channel connection). */
  tenantId: string;
  /** The channel_connections row id this message arrived on. */
  channelConnectionId: string;
  /** Which channel this came from. */
  channelType: ChannelType;
  /** Provider-side identifier of the customer (e.g. WhatsApp `from` phone). */
  customerExternalId: string;
  /**
   * Provider-side unique message id (WhatsApp `wamid`). Used for idempotency:
   * dedupe at ingest (webhook_events) and at processing (messages unique index).
   */
  channelMessageId: string;
  /** Plain text body of the message. */
  text: string;
  /** Original provider payload fragment, for debugging / future features. */
  raw: unknown;
}

/**
 * The pg-boss payload for the INBOUND_MESSAGE queue. This is exactly what the
 * WhatsApp controller enqueues and what the InboundProcessor consumes, so it
 * MUST stay a plain JSON-serializable object.
 */
export interface InboundJobData {
  tenantId: string;
  channelConnectionId: string;
  channelType: ChannelType;
  customerExternalId: string;
  channelMessageId: string;
  text: string;
}
