import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // rawBody:true is REQUIRED so the WhatsApp webhook can verify the
  // x-hub-signature-256 HMAC against the exact received bytes.
  // bufferLogs:true holds early logs until the pino logger is wired in.
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    bufferLogs: true,
  });

  // Replace Nest's default logger with nestjs-pino's structured logger.
  app.useLogger(app.get(Logger));

  // Ensure onModuleDestroy hooks (DB close, pg-boss stop) run on SIGTERM/SIGINT.
  app.enableShutdownHooks();

  const port = process.env.PORT || 3000;
  await app.listen(port);

  const logger = app.get(Logger);
  logger.log(`Assisty backend listening on port ${port}`, 'Bootstrap');
}

void bootstrap();
