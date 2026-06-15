import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import configuration, { type AppConfig } from './config/configuration';
import { validate } from './config/env.validation';

import { DatabaseModule } from './database/database.module';
import { QueueModule } from './queue/queue.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { WhatsappModule } from './channels/whatsapp/whatsapp.module';
import { AiModule } from './ai/ai.module';
import { RagModule } from './rag/rag.module';
import { ConversationsModule } from './conversations/conversations.module';
import { KbModule } from './kb/kb.module';
import { SettingsModule } from './operations/settings/settings.module';
import { CatalogModule } from './operations/catalog/catalog.module';
import { OrdersModule } from './operations/orders/orders.module';
import { WebModule } from './web/web.module';

@Module({
  imports: [
    // 1. Global config (validated + typed).
    ConfigModule.forRoot({ isGlobal: true, load: [configuration], validate }),

    // 2. Structured logging via pino.
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<{ logLevel: string; isProduction: boolean }>) => {
        const logLevel = config.get<AppConfig['logLevel']>('logLevel') ?? 'info';
        const isProduction = config.get<AppConfig['isProduction']>('isProduction') ?? false;
        return {
          pinoHttp: {
            level: logLevel,
            transport: isProduction ? undefined : { target: 'pino-pretty' },
            redact: ['req.headers.authorization', "req.headers['x-hub-signature-256']"],
          },
        };
      },
    }),

    // 3. Global infrastructure.
    DatabaseModule,
    QueueModule,
    AuthModule, // registers the global AuthGuard

    // 4. Feature modules.
    HealthModule,
    WhatsappModule,
    AiModule,
    RagModule,
    ConversationsModule,
    KbModule,

    // 5. Business Operations Layer (relational).
    SettingsModule,
    CatalogModule,
    OrdersModule,

    // 6. Web console + widget.
    WebModule,
  ],
})
export class AppModule {}
