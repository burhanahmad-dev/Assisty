import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import type { AppConfig } from '../../config/configuration';
import type { ChannelConnectionRow } from '../../database/repositories/channel-connections.repository';
import type { NormalizedInboundMessage } from '../channel.types';

/**
 * Minimal shape of the WhatsApp Cloud API webhook payload we care about.
 * We only type the fields we read; everything else is preserved in `raw`.
 */
interface WhatsappWebhookBody {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: {
        messaging_product?: string;
        metadata?: {
          display_phone_number?: string;
          phone_number_id?: string;
        };
        messages?: Array<{
          from?: string;
          id?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
        }>;
      };
    }>;
  }>;
}

/**
 * A parsed inbound message BEFORE tenant/connection resolution. The controller
 * resolves `phoneNumberId` -> channel_connection -> tenant, then enriches this
 * into a full `NormalizedInboundMessage` to enqueue.
 */
export interface ParsedWhatsappMessage {
  phoneNumberId: string;
  customerExternalId: string;
  channelMessageId: string;
  text: string;
  raw: unknown;
}

@Injectable()
export class WhatsappService {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    @InjectPinoLogger(WhatsappService.name)
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Parse a WhatsApp Cloud API webhook body into the text messages it carries.
   *
   * We walk entry[].changes[].value.messages[] and keep only `text` messages
   * (the MVP scope). Status callbacks, reactions, media, etc. are ignored.
   * This NEVER throws on a malformed payload — it returns whatever it could
   * safely extract, so the controller can always return 200.
   */
  parseWebhook(body: unknown): ParsedWhatsappMessage[] {
    const parsed: ParsedWhatsappMessage[] = [];

    const typed = body as WhatsappWebhookBody | null | undefined;
    const entries = typed?.entry;
    if (!Array.isArray(entries)) {
      return parsed;
    }

    for (const entry of entries) {
      const changes = entry?.changes;
      if (!Array.isArray(changes)) {
        continue;
      }

      for (const change of changes) {
        const value = change?.value;
        const phoneNumberId = value?.metadata?.phone_number_id;
        const messages = value?.messages;

        if (!phoneNumberId || !Array.isArray(messages)) {
          continue;
        }

        for (const message of messages) {
          const channelMessageId = message?.id;
          const customerExternalId = message?.from;
          const text = message?.text?.body;

          // MVP: only handle text messages with all the identifiers we need.
          if (
            message?.type !== 'text' ||
            !channelMessageId ||
            !customerExternalId ||
            typeof text !== 'string'
          ) {
            continue;
          }

          parsed.push({
            phoneNumberId,
            customerExternalId,
            channelMessageId,
            text,
            raw: message,
          });
        }
      }
    }

    return parsed;
  }

  /**
   * Send a plain text WhatsApp message via the Graph API.
   *
   * Per-tenant credentials (access token + phone_number_id) come from the
   * resolved channel_connection. Falls back to the single-tenant dev env vars
   * (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID) when the connection row
   * does not carry them. Logs + throws on any non-2xx so pg-boss can retry.
   */
  async sendText(
    connection: ChannelConnectionRow,
    to: string,
    text: string,
  ): Promise<void> {
    const wa = this.config.get('whatsapp', { infer: true });

    const accessToken = connection.accessToken ?? wa.accessToken;
    const phoneNumberId = connection.phoneNumberId ?? wa.phoneNumberId;

    if (!accessToken || !phoneNumberId) {
      this.logger.error(
        {
          channelConnectionId: connection.id,
          tenantId: connection.tenantId,
        },
        'cannot send WhatsApp message: missing access token or phone_number_id',
      );
      throw new Error(
        'WhatsApp connection is missing access token or phone_number_id',
      );
    }

    const url = `https://graph.facebook.com/${wa.graphVersion}/${phoneNumberId}/messages`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: text },
        }),
      });
    } catch (error) {
      // Network-level failure (DNS, timeout, connection reset).
      this.logger.error(
        {
          err: error,
          channelConnectionId: connection.id,
          tenantId: connection.tenantId,
        },
        'WhatsApp sendText network error',
      );
      throw error instanceof Error
        ? error
        : new Error('WhatsApp sendText network error');
    }

    if (!response.ok) {
      // Read the error body for logging, but never log the access token.
      const errorBody = await response.text().catch(() => '');
      this.logger.error(
        {
          channelConnectionId: connection.id,
          tenantId: connection.tenantId,
          status: response.status,
          body: errorBody,
        },
        'WhatsApp sendText returned non-2xx',
      );
      throw new Error(
        `WhatsApp sendText failed with status ${response.status}`,
      );
    }

    this.logger.info(
      {
        channelConnectionId: connection.id,
        tenantId: connection.tenantId,
      },
      'WhatsApp message sent',
    );
  }

  /**
   * Convenience: build the NormalizedInboundMessage once tenant + connection
   * are known. Kept here so the channel-specific shaping stays in the adapter.
   */
  toNormalized(
    parsed: ParsedWhatsappMessage,
    tenantId: string,
    channelConnectionId: string,
  ): NormalizedInboundMessage {
    return {
      tenantId,
      channelConnectionId,
      channelType: 'whatsapp',
      customerExternalId: parsed.customerExternalId,
      channelMessageId: parsed.channelMessageId,
      text: parsed.text,
      raw: parsed.raw,
    };
  }
}
