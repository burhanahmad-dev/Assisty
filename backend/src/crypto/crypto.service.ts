import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import type { AppConfig } from '../config/configuration';

/** Marker for AES-256-GCM payloads. Un-prefixed values are treated as legacy plaintext. */
const PREFIX = 'enc:v1:';
const INFO = Buffer.from('assisty-channel-token');

/**
 * Application-level encryption for secrets at rest (channel access tokens).
 *
 * A 256-bit per-tenant key is derived from the master key + tenant id via
 * HKDF-SHA256, then used for AES-256-GCM (random 12-byte IV, 16-byte auth tag).
 * Per-tenant derivation means a tenant's secrets can be crypto-shredded
 * independently, and a leaked DB dump is useless without the master key.
 */
@Injectable()
export class CryptoService {
  private readonly masterKey: Buffer;

  constructor(config: ConfigService<AppConfig, true>) {
    const b64 = config.get('crypto', { infer: true }).masterKey;
    this.masterKey = Buffer.from(b64, 'base64');
    if (this.masterKey.length !== 32) {
      throw new Error('ENCRYPTION_MASTER_KEY must decode to 32 bytes (base64-encoded)');
    }
  }

  private tenantKey(tenantId: string): Buffer {
    return Buffer.from(
      hkdfSync('sha256', this.masterKey, Buffer.from(tenantId), INFO, 32),
    );
  }

  /** Encrypt → "enc:v1:<iv>.<tag>.<ciphertext>" (base64 parts). */
  encrypt(tenantId: string, plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.tenantKey(tenantId), iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return (
      PREFIX +
      [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.')
    );
  }

  /** Decrypt. Values without the enc prefix are returned unchanged (legacy plaintext). */
  decrypt(tenantId: string, value: string): string {
    if (!value || !value.startsWith(PREFIX)) return value;
    const [ivB64, tagB64, ctB64] = value.slice(PREFIX.length).split('.');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.tenantKey(tenantId),
      Buffer.from(ivB64, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  /** True if a stored value is already encrypted. */
  isEncrypted(value: string | null | undefined): boolean {
    return !!value && value.startsWith(PREFIX);
  }

  encryptNullable(tenantId: string, value: string | null | undefined): string | null {
    return value ? this.encrypt(tenantId, value) : null;
  }

  decryptNullable(tenantId: string, value: string | null | undefined): string | null {
    return value ? this.decrypt(tenantId, value) : null;
  }
}
