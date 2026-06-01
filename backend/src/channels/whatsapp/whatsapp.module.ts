import { Module } from '@nestjs/common';

import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';

/**
 * WhatsApp channel module.
 *
 * DatabaseModule (repositories) and QueueModule (pg-boss) are @Global, so the
 * controller can inject ChannelConnectionsRepository, WebhookEventsRepository,
 * and QueueService without importing anything here. We only declare what this
 * module owns and exports WhatsappService for the ConversationsModule
 * (InboundProcessor) to send replies.
 */
@Module({
  controllers: [WhatsappController],
  providers: [WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule {}
