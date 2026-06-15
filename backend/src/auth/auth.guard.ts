import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { IS_PUBLIC_KEY } from './public.decorator';
import { SupabaseJwtService } from './supabase-jwt.service';
import { TenantResolverService } from './tenant-resolver.service';

/**
 * Global guard. Routes are protected by default; `@Public()` opts out
 * (health, customer web chat, widget, webhooks, /auth/config).
 *
 * For protected routes it: verifies the Supabase JWT, attaches `req.user`, and
 * resolves `req.tenantId` — so controllers read the tenant from auth via
 * `@CurrentTenant()` and can never act on the wrong tenant.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: SupabaseJwtService,
    private readonly tenants: TenantResolverService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx
      .switchToHttp()
      .getRequest<Request & { user?: unknown; tenantId?: string }>();
    const header = req.headers['authorization'];
    const token =
      typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice(7).trim()
        : null;
    if (!token) throw new UnauthorizedException('Missing bearer token');

    const user = await this.jwt.verify(token);
    req.user = user;
    req.tenantId = await this.tenants.resolveOrBootstrap(user.sub, user.email);
    return true;
  }
}
