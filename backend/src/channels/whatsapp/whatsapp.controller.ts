import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

import type { AppConfig } from '../../config/configuration';
import { ChannelConnectionsRepository } from '../../database/repositories/channel-connections.repository';
import { WebhookEventsRepository } from '../../database/repositories/webhook-events.repository';
import { QueueService } from '../../queue/queue.service';
import { QUEUES } from '../../queue/queue.constants';
import type { InboundJobData } from '../channel.types';
import { WhatsappService } from './whatsapp.service';
import { verifySignature } from './whatsapp.signature';

/**
 * WhatsApp Cloud API webhook endpoint.
 *
 *  GET  /webhooks/whatsapp  -> Meta verification handshake (hub.challenge echo).
 *  POST /webhooks/whatsapp  -> inbound message deliveries.
 *
 * The POST handler does NO LLM work. It only: verifies the HMAC over the RAW
 * body, parses + resolves each message to a tenant/connection, dedupes via
 * webhook_events, and enqueues an INBOUND_MESSAGE job. It ALWAYS returns 200
 * quickly (except a 403 on a failed signature) so Meta does not retry-storm us;
 * a parse/enqueue error for one message never blocks the 200.
 */
@Controller('webhooks/whatsapp')
export class WhatsappController {
  private readonly provider = 'whatsapp';

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly whatsapp: WhatsappService,
    private readonly connections: ChannelConnectionsRepository,
    private readonly webhookEvents: WebhookEventsRepository,
    private readonly queue: QueueService,
    @InjectPinoLogger(WhatsappController.name)
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Meta verification handshake. Echoes `hub.challenge` as a raw 200 string when
   * the mode is "subscribe" and the verify token matches; otherwise 403.
   */
  @Get()
  @Header('Content-Type', 'text/plain')
  verify(
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ): string {
    const { verifyToken } = this.config.get('whatsapp', { infer: true });

    if (mode === 'subscribe' && token === verifyToken && challenge) {
      this.logger.info('WhatsApp webhook verification succeeded');
      return challenge;
    }

    this.logger.warn(
      { mode, hasToken: Boolean(token) },
      'WhatsApp webhook verification failed',
    );
    throw new ForbiddenException('verification failed');
  }

  /**
   * Inbound webhook deliveries. Verifies HMAC over the raw body, then enqueues
   * one job per (deduped) text message. Always 200 unless the signature fails.
   */
  @Post()
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest<Request>,
  ): Promise<{ status: string }> {
    const { appSecret } = this.config.get('whatsapp', { infer: true });
    const signature = req.headers['x-hub-signature-256'];
    const signatureHeader = Array.isArray(signature) ? signature[0] : signature;

    if (!verifySignature(appSecret, req.rawBody, signatureHeader)) {
      this.logger.warn('WhatsApp webhook signature verification failed');
      throw new ForbiddenException('invalid signature');
    }

    this.logger.info('WhatsApp webhook received');

    // Never let processing one message throw out of the handler — Meta expects
    // a fast 200 and will otherwise retry the whole batch.
    try {
      await this.process(req.body);
    } catch (error) {
      this.logger.error(
        { err: error },
        'WhatsApp webhook processing error (acknowledged anyway)',
      );
    }

    return { status: 'ok' };
  }

  /**
   * Parse -> resolve tenant -> dedupe -> enqueue, per message. Each message is
   * isolated in its own try/catch so one bad message cannot drop the others.
   */
  private async process(body: unknown): Promise<void> {
    const messages = this.whatsapp.parseWebhook(body);

    if (messages.length === 0) {
      this.logger.debug('WhatsApp webhook had no processable text messages');
      return;
    }

    for (const message of messages) {
      try {
        const connection = await this.connections.findByExternalId(
          'whatsapp',
          message.phoneNumberId,
        );

        if (!connection) {
          this.logger.warn(
            { phoneNumberId: message.phoneNumberId },
            'no channel_connection for incoming WhatsApp phone_number_id; skipping',
          );
          continue;
        }

        // Idempotency at ingest: first delivery of this wamid wins.
        const claimed = await this.webhookEvents.tryClaim(
          this.provider,
          message.channelMessageId,
        );

        if (!claimed) {
          this.logger.info(
            {
              tenantId: connection.tenantId,
              wamid: message.channelMessageId,
            },
            'duplicate WhatsApp delivery; skipping enqueue',
          );
          continue;
        }

        const jobData: InboundJobData = {
          tenantId: connection.tenantId,
          channelConnectionId: connection.id,
          channelType: 'whatsapp',
          customerExternalId: message.customerExternalId,
          channelMessageId: message.channelMessageId,
          text: message.text,
        };

        const jobId = await this.queue.enqueue(
          QUEUES.INBOUND_MESSAGE,
          jobData,
        );

        this.logger.info(
          {
            tenantId: connection.tenantId,
            wamid: message.channelMessageId,
            jobId,
          },
          'enqueued inbound WhatsApp message',
        );
      } catch (error) {
        this.logger.error(
          { err: error, wamid: message.channelMessageId },
          'failed to ingest a WhatsApp message; skipping it',
        );
      }
    }
  }
}
