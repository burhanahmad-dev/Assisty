import { Global, Module } from '@nestjs/common';
import { QueueService } from './queue.service';

/**
 * Global queue module.
 *
 * Marked @Global so QueueService can be injected anywhere (controllers,
 * processors) without re-importing QueueModule in every feature module.
 * ConfigModule is already global (ConfigModule.forRoot({ isGlobal: true })),
 * so ConfigService is available to QueueService via DI.
 */
@Global()
@Module({
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
