/**
 * Seed a dev tenant + a WhatsApp channel connection so the local end-to-end
 * test (scripts/send-test-webhook.ts) resolves to a real tenant. Idempotent:
 * re-running reuses the existing connection.
 *
 *   npm run seed
 */
import './load-env';
import postgres from 'postgres';

const TEST_PHONE_NUMBER_ID = process.env.TEST_PHONE_NUMBER_ID ?? '15551234567';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set (put it in backend/.env)');
  }

  const sql = postgres(url, { max: 1, prepare: false });
  try {
    const existing = await sql<{ id: string; tenant_id: string }[]>`
      SELECT id, tenant_id
      FROM channel_connections
      WHERE type = 'whatsapp' AND external_id = ${TEST_PHONE_NUMBER_ID}
      LIMIT 1
    `;

    let tenantId: string;
    let connectionId: string;

    if (existing.length > 0) {
      tenantId = existing[0].tenant_id;
      connectionId = existing[0].id;
      console.log('Dev channel connection already exists — reusing it.');
    } else {
      const tenant = await sql<{ id: string }[]>`
        INSERT INTO tenants (name) VALUES ('Dev Tenant') RETURNING id
      `;
      tenantId = tenant[0].id;

      const conn = await sql<{ id: string }[]>`
        INSERT INTO channel_connections
          (tenant_id, type, external_id, phone_number_id, status)
        VALUES
          (${tenantId}, 'whatsapp', ${TEST_PHONE_NUMBER_ID}, ${TEST_PHONE_NUMBER_ID}, 'active')
        RETURNING id
      `;
      connectionId = conn[0].id;
    }

    console.log('Seed complete:');
    console.log('  tenantId            =', tenantId);
    console.log('  channelConnectionId =', connectionId);
    console.log('  phone_number_id     =', TEST_PHONE_NUMBER_ID);
    console.log('  (WHATSAPP_DRY_RUN should be true so replies are logged, not sent.)');
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('seed failed:', err);
  process.exit(1);
});
