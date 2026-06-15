import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { KbController } from './kb.controller';
import { KbService } from './kb.service';

/**
 * Knowledge Base / Data Sources module. Database repositories are global; we
 * import Ai for embeddings. Exposes the /kb/* collector API and exports
 * KbService for reuse.
 */
@Module({
  imports: [AiModule],
  controllers: [KbController],
  providers: [KbService],
  exports: [KbService],
})
export class KbModule {}
