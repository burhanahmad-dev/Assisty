/**
 * Queue name constants for pg-boss.
 *
 * Keep this list minimal for the MVP. Each queue name is the string
 * pg-boss uses to route jobs between producers (enqueue) and consumers (work).
 */
export const QUEUES = {
  /** Inbound channel messages awaiting deterministic brain orchestration. */
  INBOUND_MESSAGE: 'inbound-message',
} as const;

/** Union of all valid queue names. */
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
