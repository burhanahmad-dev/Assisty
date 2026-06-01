import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import postgres, { type Sql } from 'postgres';
import type { AppConfig } from '../config/configuration';

/**
 * Wraps a single postgres.js client created from DATABASE_URL.
 *
 * The client is exposed as the readonly `sql` tagged-template so repositories
 * can write safe, parameterised SQL. We use a single shared pool for the whole
 * monolith (max: 10) and disable prepared statements (`prepare: false`) which
 * is the recommended setting when running behind transaction-mode poolers such
 * as Supabase's pgbouncer.
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  public readonly sql: Sql;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    @InjectPinoLogger(DatabaseService.name)
    private readonly logger: PinoLogger,
  ) {
    const url = this.config.get('database', { infer: true }).url;
    this.sql = postgres(url, {
      max: 10,
      prepare: false,
    });
  }

  async onModuleInit(): Promise<void> {
    // Fail fast if the database is unreachable at boot.
    await this.sql`select 1`;
    this.logger.info('Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.sql.end();
    this.logger.info('Database connection closed');
  }
}
