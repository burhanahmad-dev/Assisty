import { SetMetadata } from '@nestjs/common';

/** Marks a route (or controller) as public — skips the global AuthGuard. */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);
