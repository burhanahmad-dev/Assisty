/**
 * Fire a correctly HMAC-signed WhatsApp webhook at the locally running API, to
 * exercise the full inbound -> queue -> AI -> persist -> (dry-run) outbound loop
 * without a real WhatsApp number.
 *
 *   npm run send:test                       # default text, unique wamid
 *   npm run send:test -- "your text"        # custom text
 *   npm run send:test -- "hi" wamid.FIXED   # fixed wamid (run twice to test dedup)
 *
 * Requires the API running (npm run start:dev) and a seeded connection
 * (npm run seed) whose phone_number_id matches TEST_PHONE_NUMBER_ID.
 */
import './load-env';
import { createHmac } from 'node:crypto';

const PORT = process.env.PORT ?? '3000';
const APP_SECRET = process.env.WHATSAPP_APP_SECRET ?? '';
const PHONE_NUMBER_ID = process.env.TEST_PHONE_NUMBER_ID ?? '15551234567';
const FROM = process.env.TEST_CUSTOMER ?? '15559998888';

const text = process.argv[2] ?? 'Hello Assisty, what are your opening hours?';
const wamid = process.argv[3] ?? `wamid.TEST.${Date.now()}`;

async function main(): Promise<void> {
  if (!APP_SECRET) {
    throw new Error('WHATSAPP_APP_SECRET is not set (put it in backend/.env)');
  }

  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_TEST',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: PHONE_NUMBER_ID,
                phone_number_id: PHONE_NUMBER_ID,
              },
              messages: [
                {
                  from: FROM,
                  id: wamid,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  // Sign the EXACT raw body bytes the server will verify.
  const raw = JSON.stringify(payload);
  const signature =
    'sha256=' + createHmac('sha256', APP_SECRET).update(raw).digest('hex');

  const res = await fetch(`http://localhost:${PORT}/webhooks/whatsapp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hub-signature-256': signature,
    },
    body: raw,
  });

  console.log(`POST /webhooks/whatsapp -> ${res.status} ${await res.text()}`);
  console.log(`  text : ${JSON.stringify(text)}`);
  console.log(`  wamid: ${wamid}`);
  console.log('Watch the API logs for: webhook received -> enqueued -> inbound.start -> ai.chat.completed -> DRY RUN -> inbound.done');
}

main().catch((err) => {
  console.error('send-test-webhook failed:', err);
  process.exit(1);
});
