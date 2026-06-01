/**
 * Minimal .env loader for the standalone dev scripts (seed / send-test-webhook /
 * check-openrouter). No external dependency. Loads the first .env it finds and
 * only sets keys that are not already in process.env.
 *
 * The NestJS app itself loads .env via @nestjs/config; this is only for scripts
 * run directly through ts-node.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const candidates = [
  resolve(process.cwd(), '.env'), // backend/.env when run via npm scripts
  resolve(process.cwd(), '../.env'), // repo-root .env
  resolve(__dirname, '../.env'), // backend/.env relative to this file
  resolve(__dirname, '../../.env'), // repo-root .env relative to this file
];

for (const path of candidates) {
  if (!existsSync(path)) {
    continue;
  }
  const contents = readFileSync(path, 'utf8');
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) {
      continue; // blank line or comment
    }
    const key = match[1];
    if (process.env[key] !== undefined) {
      continue;
    }
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
  // eslint-disable-next-line no-console
  console.log(`[load-env] loaded ${path}`);
  break;
}
