import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import type { AppConfig } from '../config/configuration';

export interface SupabaseUser {
  sub: string;
  email?: string;
}

/**
 * Verifies Supabase Auth access tokens (JWTs).
 *
 * Default: asymmetric verification against the project's published JWKS
 * (`/auth/v1/.well-known/jwks.json`) — handles Supabase's signing-key rotation
 * with no shared secret. Falls back to HS256 with SUPABASE_JWT_SECRET only for
 * legacy projects. Signature + expiry are always enforced by `jwtVerify`.
 */
@Injectable()
export class SupabaseJwtService {
  private readonly logger = new Logger(SupabaseJwtService.name);
  private readonly jwks?: JWTVerifyGetKey;
  private readonly hsSecret?: Uint8Array;
  private readonly issuer: string;

  constructor(private readonly config: ConfigService<AppConfig, true>) {
    const auth = this.config.get('auth', { infer: true });
    const base = auth.supabaseUrl.replace(/\/$/, '');
    this.issuer = `${base}/auth/v1`;

    if (auth.jwtSecret && auth.jwtSecret.trim()) {
      this.hsSecret = new TextEncoder().encode(auth.jwtSecret.trim());
      this.logger.log('Supabase JWT verification: HS256 (legacy secret)');
    } else {
      this.jwks = createRemoteJWKSet(
        new URL(`${this.issuer}/.well-known/jwks.json`),
      );
      this.logger.log('Supabase JWT verification: JWKS (asymmetric)');
    }
  }

  async verify(token: string): Promise<SupabaseUser> {
    try {
      let payload: JWTPayload;
      if (this.hsSecret) {
        ({ payload } = await jwtVerify(token, this.hsSecret));
      } else {
        ({ payload } = await jwtVerify(token, this.jwks as JWTVerifyGetKey));
      }
      if (!payload.sub) throw new Error('token has no sub');
      const email =
        typeof payload.email === 'string' ? payload.email : undefined;
      return { sub: payload.sub, email };
    } catch (err) {
      throw new UnauthorizedException(
        err instanceof Error && err.message === 'token has no sub'
          ? 'Malformed token'
          : 'Invalid or expired token',
      );
    }
  }
}
