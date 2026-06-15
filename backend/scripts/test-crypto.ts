/**
 * Channel-token encryption test: AES-256-GCM with per-tenant HKDF keys.
 * Proves ciphertext-at-rest, round-trip, cross-tenant key isolation, random IV,
 * tamper detection, and legacy-plaintext passthrough. Run: npm run test:crypto
 */
import './load-env';
import { CryptoService } from '../src/crypto/crypto.service';

/* eslint-disable @typescript-eslint/no-explicit-any */
const config = { get: () => ({ masterKey: process.env.ENCRYPTION_MASTER_KEY as string }) } as any;
const crypto = new CryptoService(config);

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean): void {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name); }
}
function throws(fn: () => unknown): boolean {
  try { fn(); return false; } catch { return true; }
}

const tA = '11111111-1111-1111-1111-111111111111';
const tB = '22222222-2222-2222-2222-222222222222';
const secret = 'EAAG-whatsapp-access-token-XYZ-very-secret';

const enc = crypto.encrypt(tA, secret);
check('stored value is encrypted (prefixed) and contains no plaintext', enc.startsWith('enc:v1:') && !enc.includes(secret));
check('round-trips for the owning tenant', crypto.decrypt(tA, enc) === secret);
check('a DIFFERENT tenant cannot decrypt it (key isolation)', throws(() => crypto.decrypt(tB, enc)));
check('encrypting twice yields different ciphertext (random IV)', crypto.encrypt(tA, secret) !== crypto.encrypt(tA, secret));
check('tampered ciphertext is rejected (GCM auth)', throws(() => {
  const tampered = enc.slice(0, -2) + (enc.endsWith('A') ? 'B' : 'A');
  return crypto.decrypt(tA, tampered);
}));
check('legacy plaintext passes through on decrypt', crypto.decrypt(tA, 'legacy-plain-token') === 'legacy-plain-token');
check('nullable helpers handle null', crypto.encryptNullable(tA, null) === null && crypto.decryptNullable(tA, null) === null);

console.log(`\ncrypto: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
