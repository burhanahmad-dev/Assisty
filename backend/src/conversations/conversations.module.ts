import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { RagModule } from '../rag/rag.module';
import { WhatsappModule } from '../channels/whatsapp/whatsapp.module';
import { KbModule } from '../kb/kb.module';
import { SettingsModule } from '../operations/settings/settings.module';
import { InboundProcessor } from './inbound.processor';

/**
 * ConversationsModule wires the deterministic "brain" pipeline.
 *
 * It imports AiModule (chat), RagModule (retrieval) and WhatsappModule (reply
 * delivery). QueueModule and DatabaseModule are @Global, so QueueService and
 * all repositories are injected into InboundProcessor without re-importing.
 *
 * InboundProcessor self-registers its pg-boss worker on module init.
 */
@Module({
  imports: [AiModule, RagModule, WhatsappModule, KbModule, SettingsModule],
  providers: [InboundProcessor],
})
export class ConversationsModule {}
