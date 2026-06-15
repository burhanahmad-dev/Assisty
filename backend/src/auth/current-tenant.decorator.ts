import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * Injects the authenticated operator's `tenantId` (set by AuthGuard from the
 * verified Supabase JWT). Throws if used on a route that wasn't authenticated —
 * a guard against accidentally exposing tenant-scoped work on a public route.
 */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<Request & { tenantId?: string }>();
    if (!req.tenantId) {
      throw new InternalServerErrorException('No tenant context on this request');
    }
    return req.tenantId;
  },
);

/** Injects the authenticated Supabase user ({ sub, email }). */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<Request & { user?: unknown }>();
    return req.user;
  },
);
