import { Module } from '@nestjs/common';
import { AiService } from './ai.service';

/**
 * AiModule exposes the AiService (chat + embeddings via the LiteLLM proxy).
 * DatabaseModule and QueueModule are @Global, so nothing else needs importing.
 */
@Module({
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
