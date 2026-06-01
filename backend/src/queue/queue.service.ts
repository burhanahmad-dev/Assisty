import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import PgBoss from 'pg-boss';
import type { AppConfig } from '../config/configuration';
import { QUEUES, type QueueName } from './queue.constants';

/**
 * Thin wrapper around pg-boss (Postgres-backed job queue, NO Redis).
 *
 * Lifecycle:
 *  - onModuleInit  -> new PgBoss(...) + start() + createQueue() for each queue
 *                     (pg-boss v10 requires queues to exist before send/work).
 *  - onModuleDestroy -> stop({ graceful: true }) so in-flight jobs finish.
 *
 * Idempotency is handled OUTSIDE this service:
 *  - WebhookEventsRepository.tryClaim at ingest (dedupe webhook deliveries)
 *  - messages.channel_message_id UNIQUE at processing (idempotent inbound)
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private boss?: PgBoss;

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async onModuleInit(): Promise<void> {
    const databaseUrl = this.config.get('database', { infer: true }).url;

    // node-pg now treats sslmode=require as verify-full, which rejects Supabase's
    // pooler certificate chain ("self-signed certificate in certificate chain").
    // Strip the sslmode query and pass an explicit ssl option (encrypt, do not
    // verify) for remote hosts; local/docker Postgres connects without TLS.
    let connectionString = databaseUrl;
    let host = '';
    try {
      const parsed = new URL(databaseUrl);
      host = parsed.hostname;
      parsed.searchParams.delete('sslmode');
      connectionString = parsed.toString();
    } catch {
      connectionString = databaseUrl;
    }
    const isLocal = ['localhost', '127.0.0.1', '::1', 'postgres'].includes(host);

    this.boss = new PgBoss(
      isLocal
        ? { connectionString }
        : { connectionString, ssl: { rejectUnauthorized: false } },
    );

    // Surface pg-boss internal errors through structured logging.
    this.boss.on('error', (error) => {
      this.logger.error({ err: error }, 'pg-boss emitted an internal error');
    });

    await this.boss.start();

    // pg-boss v10 makes queues explicit: send()/work() to a non-existent queue
    // is silently dropped. Create each known queue on boot (idempotent).
    for (const queue of Object.values(QUEUES)) {
      try {
        await this.boss.createQueue(queue);
      } catch (err) {
        this.logger.warn({
          msg: 'queue.create.skipped',
          queue,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.logger.log({ msg: 'pg-boss started', queues: Object.values(QUEUES) });
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
   * Enqueue a job. Defaults: retryLimit 5 with exponential backoff so transient
   * failures (LLM 429/5xx, network blips, WhatsApp Graph hiccups) are retried.
   * @returns the pg-boss job id, or null if pg-boss debounced/dropped it.
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
   * Register a worker for a queue. batchSize 1 = simple one-job-at-a-time
   * processing. Handlers RETHROW on failure so pg-boss applies the retry policy.
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
