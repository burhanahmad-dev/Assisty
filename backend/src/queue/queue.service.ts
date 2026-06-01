import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import PgBoss from 'pg-boss';
import type { AppConfig } from '../config/configuration';
import type { QueueName } from './queue.constants';

/**
 * Thin wrapper around pg-boss (Postgres-backed job queue, NO Redis).
 *
 * Lifecycle:
 *  - onModuleInit  -> new PgBoss(DATABASE_URL) + boss.start() (pg-boss creates
 *                     its own schema/tables automatically on first boot).
 *  - onModuleDestroy -> boss.stop({ graceful: true }) so in-flight jobs finish.
 *
 * Idempotency is handled OUTSIDE this service:
 *  - WebhookEventsRepository.tryClaim at ingest time (dedupe webhook deliveries)
 *  - messages.channel_message_id UNIQUE at processing time (dedupe re-runs)
 * So enqueue() does not attempt single-active dedupe itself.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private boss?: PgBoss;

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async onModuleInit(): Promise<void> {
    const databaseUrl = this.config.get('database', { infer: true }).url;

    this.boss = new PgBoss(databaseUrl);

    // Surface pg-boss internal errors through structured logging.
    this.boss.on('error', (error) => {
      this.logger.error(
        { err: error },
        'pg-boss emitted an internal error',
      );
    });

    await this.boss.start();
    this.logger.log('pg-boss started');
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.boss) {
      return;
    }

    try {
      await this.boss.stop({ graceful: true });
      this.logger.log('pg-boss stopped gracefully');
    } catch (error) {
      this.logger.error({ err: error }, 'pg-boss failed to stop gracefully');
    } finally {
      this.boss = undefined;
    }
  }

  /**
   * Enqueue a job onto a queue.
   *
   * Defaults: retryLimit 5 with exponential backoff so transient failures
   * (LLM 429/5xx, network blips, WhatsApp Graph hiccups) are retried reliably.
   * Callers may override any send option via `opts`.
   *
   * @returns the pg-boss job id, or null if pg-boss debounced/throttled it away.
   */
  async enqueue<T extends object>(
    name: QueueName,
    data: T,
    opts: PgBoss.SendOptions = {},
  ): Promise<string | null> {
    const boss = this.requireBoss();

    const jobId = await boss.send(name, data, {
      retryLimit: 5,
      retryBackoff: true,
      ...opts,
    });

    this.logger.log({ queue: name, jobId }, 'enqueued job');
    return jobId;
  }

  /**
   * Register a worker for a queue. pg-boss invokes the handler with a batch of
   * jobs; we pin batchSize to 1 for simple, readable, one-job-at-a-time
   * processing. Handlers should try/catch + log, then RETHROW on failure so
   * pg-boss applies the retry policy attached at enqueue time.
   */
  async work<T extends object>(
    name: QueueName,
    handler: (job: PgBoss.Job<T>) => Promise<void>,
  ): Promise<string> {
    const boss = this.requireBoss();

    const workerId = await boss.work<T>(
      name,
      { batchSize: 1 },
      async (jobs) => {
        for (const job of jobs) {
          await handler(job);
        }
      },
    );

    this.logger.log({ queue: name, workerId }, 'registered worker');
    return workerId;
  }

  private requireBoss(): PgBoss {
    if (!this.boss) {
      throw new Error('QueueService used before pg-boss was started');
    }
    return this.boss;
  }
}
