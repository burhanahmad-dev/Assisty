import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
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

  // Security headers. CSP/CORP/COEP are relaxed because the operator console and
  // the embeddable widget rely on inline scripts + cross-origin <script> loads;
  // everything else (HSTS, X-Content-Type-Options, frameguard, etc.) stays on.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  // Validate + sanitise request bodies: strip unknown fields and reject junk.
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  // Allow the embeddable website widget (loaded on any site) to call the API.
  // Admin routes are JWT-protected, so open CORS does not expose tenant data.
  app.enableCors({ origin: true });

  // Ensure onModuleDestroy hooks (DB close, pg-boss stop) run on SIGTERM/SIGINT.
  app.enableShutdownHooks();

  const port = process.env.PORT || 3000;
  await app.listen(port);

  const logger = app.get(Logger);
  logger.log(`Assisty backend listening on port ${port}`, 'Bootstrap');
}

void bootstrap();
