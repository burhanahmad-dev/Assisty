import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import postgres, { type Sql, type TransactionSql } from 'postgres';
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

  /**
   * Run `fn` inside a TENANT-SCOPED transaction so Postgres RLS enforces
   * isolation: it sets `app.tenant_id` then `SET LOCAL ROLE assisty_app` (a
   * NOBYPASSRLS, non-owner role), both reset on commit. ALL tenant data access
   * MUST go through here.
   *
   * The raw `sql` (admin/postgres connection) BYPASSES RLS and is reserved for
   * tenant RESOLUTION + infra only (auth lookup/bootstrap, webhook dedupe,
   * health) — never for serving tenant data.
   */
  async scoped<T>(
    tenantId: string,
    fn: (sql: TransactionSql) => Promise<T>,
  ): Promise<T> {
    return this.sql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      await tx.unsafe('SET LOCAL ROLE assisty_app');
      return fn(tx);
    }) as unknown as Promise<T>;
  }

  async onModuleDestroy(): Promise<void> {
    await this.sql.end();
    this.logger.info('Database connection closed');
  }
}
