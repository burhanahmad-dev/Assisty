import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { RagService } from './rag.service';

/**
 * RagModule provides retrieval-augmented generation helpers.
 * Depends on AiModule for embeddings; the KbRepository is available globally
 * via the @Global DatabaseModule.
 */
@Module({
  imports: [AiModule],
  providers: [RagService],
  exports: [RagService],
})
export class RagModule {}
