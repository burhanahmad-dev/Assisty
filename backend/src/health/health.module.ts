import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/**
 * DatabaseService is provided by the @Global() DatabaseModule, so it is
 * injectable into HealthController without importing DatabaseModule here.
 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
