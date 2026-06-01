import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import configuration, { type AppConfig } from './config/configuration';
import { validate } from './config/env.validation';

import { DatabaseModule } from './database/database.module';
import { QueueModule } from './queue/queue.module';
import { HealthModule } from './health/health.module';
import { WhatsappModule } from './channels/whatsapp/whatsapp.module';
import { AiModule } from './ai/ai.module';
import { RagModule } from './rag/rag.module';
import { ConversationsModule } from './conversations/conversations.module';

@Module({
  imports: [
    // 1. Global config (validated + typed). isGlobal so ConfigService injects anywhere.
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate,
    }),

    // 2. Structured logging via pino. Pretty in dev, JSON in prod. Redacts secrets.
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
            redact: [
              'req.headers.authorization',
              "req.headers['x-hub-signature-256']",
            ],
          },
        };
      },
    }),

    // 3. Global infrastructure modules (exported services inject without re-import).
    DatabaseModule,
    QueueModule,

    // 4. Feature modules.
    HealthModule,
    WhatsappModule,
    AiModule,
    RagModule,
    ConversationsModule,
  ],
})
export class AppModule {}
