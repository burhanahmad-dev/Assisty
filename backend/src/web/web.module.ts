import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { RagModule } from '../rag/rag.module';
import { CatalogModule } from '../operations/catalog/catalog.module';
import { OrdersModule } from '../operations/orders/orders.module';
import { SettingsModule } from '../operations/settings/settings.module';
import { WebController } from './web.controller';
import { WidgetController } from './widget.controller';
import { WebChatService } from './web-chat.service';
import { CommerceService } from './commerce.service';

/**
 * Web test console (/test), synchronous chat (/web/chat), the embeddable widget
 * (/widget.js, /widget-demo), and the commerce bridge (order-fetch + product
 * suggestions) that connects the conversation to the Operations Layer.
 */
@Module({
  imports: [AiModule, RagModule, CatalogModule, OrdersModule, SettingsModule],
  controllers: [WebController, WidgetController],
  providers: [WebChatService, CommerceService],
})
export class WebModule {}
