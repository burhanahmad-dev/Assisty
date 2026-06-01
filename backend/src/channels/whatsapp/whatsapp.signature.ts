import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a Meta/WhatsApp webhook HMAC signature.
 *
 * Meta signs the RAW request body with the app secret (HMAC-SHA256) and sends
 * the result in the `X-Hub-Signature-256` header as `sha256=<hex>`. We MUST
 * compute the HMAC over the exact raw bytes (that is why main.ts enables
 * `rawBody: true`) — re-serializing the parsed JSON would change the bytes and
 * break verification.
 *
 * Uses a constant-time comparison (`crypto.timingSafeEqual`) to avoid leaking
 * timing information, and guards against length mismatches (timingSafeEqual
 * throws if the buffers differ in length).
 *
 * @param appSecret   The WhatsApp app secret (WHATSAPP_APP_SECRET).
 * @param rawBody     The raw request body bytes. If undefined/empty -> false.
 * @param headerValue The `X-Hub-Signature-256` header value (`sha256=<hex>`).
 * @returns true only if the signature is present, well-formed, and matches.
 */
export function verifySignature(
  appSecret: string,
  rawBody: Buffer | undefined,
  headerValue: string | undefined,
): boolean {
  if (!appSecret || !rawBody || rawBody.length === 0 || !headerValue) {
    return false;
  }

  // Header must be of the form "sha256=<hex>".
  const prefix = 'sha256=';
  if (!headerValue.startsWith(prefix)) {
    return false;
  }

  const providedHex = headerValue.slice(prefix.length);
  if (providedHex.length === 0) {
    return false;
  }

  const expectedHex = createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex');

  // Compare as bytes in constant time. timingSafeEqual requires equal lengths,
  // so bail early on a length mismatch (which itself means a non-match).
  const providedBuf = Buffer.from(providedHex, 'hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');

  if (providedBuf.length !== expectedBuf.length || providedBuf.length === 0) {
    return false;
  }

  try {
    return timingSafeEqual(providedBuf, expectedBuf);
  } catch {
    return false;
  }
}
