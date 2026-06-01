/**
 * Read recent conversations + messages back from the database — proof that the
 * pipeline persisted both the inbound and the AI's outbound reply.
 *
 *   npx ts-node scripts/show-messages.ts
 */
import './load-env';
import postgres from 'postgres';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const sql = postgres(url, { max: 1, prepare: false });
  try {
    const convos = await sql<
      { id: string; customer_external_id: string; status: string }[]
    >`SELECT id, customer_external_id, status FROM conversations ORDER BY created_at DESC LIMIT 5`;
    console.log(`conversations: ${convos.length}`);
    for (const c of convos) {
      console.log(`  ${c.id}  customer=${c.customer_external_id}  status=${c.status}`);
    }

    const msgs = await sql<
      {
        direction: string;
        model: string | null;
        channel_message_id: string | null;
        content: string | null;
      }[]
    >`SELECT direction, model, channel_message_id, left(content, 140) AS content
        FROM messages ORDER BY created_at DESC LIMIT 12`;
    console.log(`\nrecent messages (newest first):`);
    for (const m of msgs) {
      console.log(
        `  [${m.direction}] model=${m.model ?? '-'} wamid=${m.channel_message_id ?? '-'}`,
      );
      console.log(`      ${m.content}`);
    }

    const counts = await sql<{ direction: string; n: number }[]>`
      SELECT direction, count(*)::int AS n FROM messages GROUP BY direction`;
    console.log(
      `\ncounts: ${counts.map((c) => `${c.direction}=${c.n}`).join('  ')}`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('show-messages failed:', err);
  process.exit(1);
});
