import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from 'pg-boss';

import { QueueService } from '../queue/queue.service';
import { QUEUES } from '../queue/queue.constants';
import type { InboundJobData } from '../channels/channel.types';
import { AiService, type ChatMessage } from '../ai/ai.service';
import { RagService } from '../rag/rag.service';
import { WhatsappService } from '../channels/whatsapp/whatsapp.service';
import { ConversationsRepository } from '../database/repositories/conversations.repository';
import {
  MessagesRepository,
  type MessageRow,
} from '../database/repositories/messages.repository';
import { ChannelConnectionsRepository } from '../database/repositories/channel-connections.repository';
import { UsageRepository } from '../database/repositories/usage.repository';

/**
 * The "brain" of Assisty — a deterministic, linear pipeline (NO LangGraph, NO
 * fancy orchestration). It consumes INBOUND_MESSAGE jobs enqueued by the
 * channel controllers and runs, top-to-bottom:
 *
 *   (1) idempotency guard (messages.channel_message_id)
 *   (2) find-or-create conversation
 *   (3) persist the inbound message
 *   (4) RAG retrieve
 *   (5) build the prompt (persona + grounding context + recent history + user)
 *   (6) chat completion
 *   (7) persist the outbound message
 *   (8) send the reply over the originating channel
 *   (9) record usage (ai_tokens + messages)
 *
 * On ANY failure we log with full context and rethrow so pg-boss applies the
 * retry policy attached at enqueue time. Idempotency (steps 1 + 3) makes those
 * retries safe.
 */
@Injectable()
export class InboundProcessor implements OnModuleInit {
  private readonly logger = new Logger(InboundProcessor.name);

  /** How many prior turns to feed the model as conversational history. */
  private static readonly HISTORY_LIMIT = 10;

  constructor(
    private readonly queue: QueueService,
    private readonly ai: AiService,
    private readonly rag: RagService,
    private readonly whatsapp: WhatsappService,
    private readonly conversations: ConversationsRepository,
    private readonly messages: MessagesRepository,
    private readonly channelConnections: ChannelConnectionsRepository,
    private readonly usage: UsageRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.work<InboundJobData>(
      QUEUES.INBOUND_MESSAGE,
      (job) => this.handle(job),
    );
    this.logger.log({ msg: 'inbound.processor.registered', queue: QUEUES.INBOUND_MESSAGE });
  }

  private async handle(job: Job<InboundJobData>): Promise<void> {
    const {
      tenantId,
      channelConnectionId,
      customerExternalId,
      channelMessageId,
      text,
    } = job.data;

    const ctx = {
      jobId: job.id,
      tenantId,
      channelConnectionId,
      wamid: channelMessageId,
    };

    this.logger.log({ msg: 'inbound.start', ...ctx });

    try {
      // (1) Idempotency: if we already stored this provider message, stop.
      if (await this.messages.existsByChannelMessageId(channelMessageId)) {
        this.logger.log({ msg: 'inbound.skip.duplicate', ...ctx });
        return;
      }

      // (2) Find or create the conversation for this customer + connection.
      const conversation = await this.conversations.findOrCreate(
        tenantId,
        channelConnectionId,
        customerExternalId,
      );

      // (3) Persist the inbound message.
      await this.messages.insertInbound({
        tenantId,
        conversationId: conversation.id,
        channelMessageId,
        content: text,
      });

      // (4) Retrieve grounding context from the knowledge base.
      const chunks = await this.rag.retrieve(tenantId, text);
      const contextBlock = this.rag.buildContextBlock(chunks);

      // (5) Build the chat prompt.
      const history = await this.messages.recentByConversation(
        conversation.id,
        InboundProcessor.HISTORY_LIMIT,
      );
      const promptMessages = this.buildMessages(contextBlock, history, text);

      // (6) Chat completion via LiteLLM.
      const result = await this.ai.chat({ messages: promptMessages });
      const reply = result.content.trim();

      if (!reply) {
        // A blank completion is treated as a failure so pg-boss retries.
        throw new Error('AI returned an empty completion');
      }

      // (7) Persist the outbound message.
      await this.messages.insertOutbound({
        tenantId,
        conversationId: conversation.id,
        content: reply,
        model: result.model,
        tokens: result.usageTokens,
      });

      // (8) Send the reply over the originating channel.
      const connection = await this.channelConnections.findById(
        channelConnectionId,
      );
      if (!connection) {
        throw new Error(
          `Channel connection ${channelConnectionId} not found while replying`,
        );
      }
      await this.whatsapp.sendText(connection, customerExternalId, reply);

      // (9) Record usage. Best-effort: a ledger write failure must not undo a
      // delivered reply or trigger a retry that would double-send.
      try {
        await this.usage.record(tenantId, 'ai_tokens', result.usageTokens);
        await this.usage.record(tenantId, 'messages', 1);
      } catch (usageErr) {
        this.logger.warn({
          msg: 'inbound.usage.record_failed',
          ...ctx,
          error: usageErr instanceof Error ? usageErr.message : String(usageErr),
        });
      }

      this.logger.log({
        msg: 'inbound.done',
        ...ctx,
        conversationId: conversation.id,
        model: result.model,
        usageTokens: result.usageTokens,
      });
    } catch (err) {
      this.logger.error({
        msg: 'inbound.failed',
        ...ctx,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      // Rethrow so pg-boss retries (retryLimit/backoff set at enqueue time).
      throw err;
    }
  }

  /**
   * Assemble the chat messages: a grounded system persona, the recent
   * conversation history, then the new user turn.
   */
  private buildMessages(
    contextBlock: string,
    history: MessageRow[],
    userText: string,
  ): ChatMessage[] {
    const messages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt(contextBlock) },
    ];

    for (const msg of history) {
      messages.push({
        role: msg.direction === 'inbound' ? 'user' : 'assistant',
        content: msg.content,
      });
    }

    messages.push({ role: 'user', content: userText });
    return messages;
  }

  /** The assistant persona + grounding instructions + retrieved context. */
  private systemPrompt(contextBlock: string): string {
    const base =
      'You are Assisty, a helpful, concise customer-support assistant. ' +
      'Answer ONLY using the context provided below. ' +
      'If the answer is not in the context, say you are not sure and offer to ' +
      'connect the customer with a human. Do not invent facts.';

    if (!contextBlock) {
      return `${base}\n\nContext:\n(no relevant context found)`;
    }
    return `${base}\n\nContext:\n${contextBlock}`;
  }
}
