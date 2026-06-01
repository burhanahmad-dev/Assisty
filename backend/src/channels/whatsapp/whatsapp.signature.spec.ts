import { createHmac } from 'node:crypto';

import { verifySignature } from './whatsapp.signature';

/**
 * Reliability test for WhatsApp HMAC verification. A wrong signature MUST fail
 * and a correctly-computed one MUST pass — this is the gate that keeps spoofed
 * webhooks out of the queue.
 */
describe('verifySignature', () => {
  const appSecret = 'test-app-secret';
  const rawBody = Buffer.from(
    JSON.stringify({ object: 'whatsapp_business_account', entry: [] }),
  );

  const validHeader =
    'sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex');

  it('accepts a correctly computed signature', () => {
    expect(verifySignature(appSecret, rawBody, validHeader)).toBe(true);
  });

  it('rejects a signature computed with the wrong secret', () => {
    const wrongHeader =
      'sha256=' +
      createHmac('sha256', 'wrong-secret').update(rawBody).digest('hex');
    expect(verifySignature(appSecret, rawBody, wrongHeader)).toBe(false);
  });

  it('rejects a tampered body', () => {
    const tampered = Buffer.from(JSON.stringify({ object: 'tampered' }));
    expect(verifySignature(appSecret, tampered, validHeader)).toBe(false);
  });

  it('rejects a header without the sha256= prefix', () => {
    const hexOnly = createHmac('sha256', appSecret)
      .update(rawBody)
      .digest('hex');
    expect(verifySignature(appSecret, rawBody, hexOnly)).toBe(false);
  });

  it('rejects a malformed (non-hex / short) signature without throwing', () => {
    expect(verifySignature(appSecret, rawBody, 'sha256=not-hex')).toBe(false);
    expect(verifySignature(appSecret, rawBody, 'sha256=ab')).toBe(false);
  });

  it('rejects when the raw body is missing', () => {
    expect(verifySignature(appSecret, undefined, validHeader)).toBe(false);
    expect(verifySignature(appSecret, Buffer.alloc(0), validHeader)).toBe(
      false,
    );
  });

  it('rejects when the header is missing', () => {
    expect(verifySignature(appSecret, rawBody, undefined)).toBe(false);
  });

  it('rejects when the app secret is empty', () => {
    expect(verifySignature('', rawBody, validHeader)).toBe(false);
  });
});
