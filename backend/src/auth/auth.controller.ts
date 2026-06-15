import { Controller, Get, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import type { AppConfig } from '../config/configuration';
import { Public } from './public.decorator';
import { CurrentTenant } from './current-tenant.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  /**
   * Public: the console uses these to talk to Supabase Auth (login/signup)
   * directly from the browser. The anon (publishable) key is safe client-side.
   */
  @Public()
  @Get('config')
  authConfig(): { supabaseUrl: string; anonKey: string } {
    const auth = this.config.get('auth', { infer: true });
    return { supabaseUrl: auth.supabaseUrl, anonKey: auth.supabaseAnonKey };
  }

  /** Protected: confirms the token is valid and returns the resolved tenant. */
  @Get('me')
  me(
    @CurrentTenant() tenantId: string,
    @Req() req: Request & { user?: { email?: string } },
  ): { tenantId: string; email?: string } {
    return { tenantId, email: req.user?.email };
  }
}
