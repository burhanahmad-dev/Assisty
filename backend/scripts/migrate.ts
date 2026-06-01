/**
 * Dead-simple migration runner for the Assisty MVP.
 *
 * Reads every *.sql file in ../../supabase/migrations (relative to this file),
 * sorts them by filename, and executes each against DATABASE_URL using the same
 * postgres.js driver the app uses.
 *
 * No migration-tracking table: every migration is written to be idempotent
 * (IF NOT EXISTS / ON CONFLICT), so re-running is safe. Each file runs inside a
 * transaction so a failure mid-file rolls back cleanly.
 *
 * Usage: npm run migrate
 */
import './load-env';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import postgres from 'postgres';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('[migrate] DATABASE_URL is not set');
    process.exit(1);
  }

  // scripts/ -> backend/ -> repo root -> supabase/migrations
  const migrationsDir = resolve(__dirname, '..', '..', 'supabase', 'migrations');

  let files: string[];
  try {
    files = readdirSync(migrationsDir)
      .filter((f) => f.toLowerCase().endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    console.error(`[migrate] could not read migrations dir: ${migrationsDir}`, err);
    process.exit(1);
    return;
  }

  if (files.length === 0) {
    console.log(`[migrate] no .sql files found in ${migrationsDir} — nothing to do`);
    process.exit(0);
    return;
  }

  // `prepare: false` to match runtime config and play nicely with poolers.
  const sql = postgres(databaseUrl, { max: 1, prepare: false });

  try {
    for (const file of files) {
      const fullPath = join(migrationsDir, file);
      const contents = readFileSync(fullPath, 'utf8');

      console.log(`[migrate] applying ${file} ...`);
      // Run the whole file as one script inside a transaction. sql.unsafe is
      // required because the file contains multiple statements / DDL.
      await sql.begin(async (tx) => {
        await tx.unsafe(contents);
      });
      console.log(`[migrate] applied  ${file}`);
    }

    console.log(`[migrate] done — ${files.length} file(s) applied`);
    await sql.end();
    process.exit(0);
  } catch (err) {
    console.error('[migrate] migration failed:', err);
    await sql.end({ timeout: 5 }).catch(() => undefined);
    process.exit(1);
  }
}

void main();
