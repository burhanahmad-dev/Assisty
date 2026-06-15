import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { SupabaseJwtService } from './supabase-jwt.service';
import { TenantResolverService } from './tenant-resolver.service';

/**
 * Authentication: verifies Supabase JWTs and resolves the tenant. Registers the
 * AuthGuard GLOBALLY (every route protected unless `@Public()`). DatabaseService
 * is global, so TenantResolverService gets it without re-importing.
 */
@Module({
  controllers: [AuthController],
  providers: [
    SupabaseJwtService,
    TenantResolverService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [SupabaseJwtService, TenantResolverService],
})
export class AuthModule {}
