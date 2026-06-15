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
import { KbService } from '../kb/kb.service';
import { SettingsService } from '../operations/settings/settings.service';

/**
 * Sent to the customer when the AI cannot produce a reply (even after the
 * AiService's own internal retry). Guarantees a customer is NEVER left without
 * a response — a core reliability requirement.
 */
export const FALLBACK_REPLY =
  "Sorry — I'm having trouble answering that right now. I've passed your message on and a team member will follow up shortly.";

/**
 * The "brain" of Assisty — a deterministic, linear pipeline (NO LangGraph, NO
 * fancy orchestration). It consumes INBOUND_MESSAGE jobs and runs top-to-bottom:
 *
 *   (1) find-or-create conversation
 *   (2) persist the inbound message  (idempotent: ON CONFLICT DO NOTHING)
 *   (3) RAG retrieve (best-effort — degrades to no-context, never fails the turn)
 *   (4) build the prompt (persona + grounding + recent history + user)
 *   (5) chat completion WITH a graceful fallback reply if the AI fails
 *   (6) persist the outbound message (real reply OR fallback)
 *   (7) send the reply over the originating channel
 *   (8) record usage (best-effort)
 *
 * Idempotency / safe retries:
 *   - Duplicate webhook DELIVERIES are stopped at ingest by webhook_events.
 *   - Step (2) is idempotent, so a pg-boss RETRY (which only happens when a
 *     later step throws — e.g. the channel send fails) re-runs cleanly and the
 *     reply is re-attempted instead of being silently skipped.
 *   - AI failures do NOT throw (they fall back), so we never burn retries on a
 *     down model; only genuine infra failures (DB / channel send) trigger a
 *     retry. A send-failure retry may persist a duplicate outbound row in the
 *     rare case the channel API is unreachable — an acceptable MVP trade for
 *     guaranteed delivery.
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
    private readonly kb: KbService,
    private readonly settings: SettingsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.work<InboundJobData>(QUEUES.INBOUND_MESSAGE, (job) =>
      this.handle(job),
    );
    this.logger.log({
      msg: 'inbound.processor.registered',
      queue: QUEUES.INBOUND_MESSAGE,
    });
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
      // (1) Find or create the conversation for this customer + connection.
      const conversation = await this.conversations.findOrCreate(
        tenantId,
        channelConnectionId,
        customerExternalId,
      );

      // (2) Persist the inbound message (idempotent — safe under retries).
      await this.messages.insertInbound({
        tenantId,
        conversationId: conversation.id,
        channelMessageId,
        content: text,
      });

      // (3) Retrieve grounding context (best-effort; never fails the turn).
      const chunks = await this.rag.retrieve(tenantId, text);
      const contextBlock = this.rag.buildContextBlock(chunks);

      // (4) Load THIS tenant's persona (Master Prompt) + custom commands (Agent
      //     Memory), then build the prompt from persona + rules + context +
      //     recent history. Both are per-tenant, so each business's WhatsApp
      //     agent follows its own configured behaviour.
      const [persona, rules, settings] = await Promise.all([
        this.kb.getAgentInstructions(tenantId),
        this.kb.getCustomRules(tenantId),
        this.settings.get(tenantId),
      ]);
      const selectedModel =
        settings.model && settings.model.trim() ? settings.model.trim() : undefined;
      const history = await this.messages.recentByConversation(
        tenantId,
        conversation.id,
        InboundProcessor.HISTORY_LIMIT,
      );
      const promptMessages = this.buildMessages(
        contextBlock,
        history,
        text,
        persona,
        rules,
      );

      // (5) Chat completion WITH graceful fallback. AiService already does one
      //     internal retry on 429/5xx; if it still fails we reply with a
      //     fallback rather than leaving the customer hanging.
      let reply: string;
      let model = 'fallback';
      let usageTokens = 0;
      let usedFallback = false;

      try {
        const result = await this.ai.chat({ messages: promptMessages, model: selectedModel });
        reply = result.content.trim();
        if (!reply) {
          throw new Error('AI returned an empty completion');
        }
        model = result.model;
        usageTokens = result.usageTokens;
      } catch (aiErr) {
        this.logger.error({
          msg: 'inbound.ai_failed.fallback',
          ...ctx,
          error: aiErr instanceof Error ? aiErr.message : String(aiErr),
        });
        reply = FALLBACK_REPLY;
        usedFallback = true;
      }

      // (6) Persist the outbound message (real reply or fallback).
      await this.messages.insertOutbound({
        tenantId,
        conversationId: conversation.id,
        content: reply,
        model,
        tokens: usageTokens,
      });

      // (7) Send the reply over the originating channel. A failure here throws
      //     -> pg-boss retries (step 2 keeps that safe).
      const connection =
        await this.channelConnections.findById(tenantId, channelConnectionId);
      if (!connection) {
        throw new Error(
          `Channel connection ${channelConnectionId} not found while replying`,
        );
      }
      await this.whatsapp.sendText(connection, customerExternalId, reply);

      // (8) Record usage. Best-effort: a ledger write failure must not undo a
      //     delivered reply or trigger a retry that would double-send.
      try {
        await this.usage.record(tenantId, 'ai_tokens', usageTokens, model);
        await this.usage.record(tenantId, 'messages', 1, model);
      } catch (usageErr) {
        this.logger.warn({
          msg: 'inbound.usage.record_failed',
          ...ctx,
          error:
            usageErr instanceof Error ? usageErr.message : String(usageErr),
        });
      }

      this.logger.log({
        msg: 'inbound.done',
        ...ctx,
        conversationId: conversation.id,
        model,
        usageTokens,
        usedFallback,
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
    persona: string,
    rules: Array<{ label?: string; instruction: string }>,
  ): ChatMessage[] {
    const messages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt(contextBlock, persona, rules) },
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

  /**
   * The assistant persona (tenant Master Prompt) + custom commands (Agent
   * Memory) + grounding instructions + retrieved context. Persona and rules are
   * per-tenant, so each business's WhatsApp agent follows its own configuration.
   */
  private systemPrompt(
    contextBlock: string,
    persona: string,
    rules: Array<{ label?: string; instruction: string }>,
  ): string {
    const base =
      persona && persona.trim()
        ? persona.trim()
        : 'You are Assisty, a helpful, concise customer-support assistant.';

    const grounding =
      'Answer using the context below. If the answer is not in the context, say you ' +
      'are not sure and offer to connect the customer with a human. Do not invent facts.';

    const rulesText = (rules ?? [])
      .filter((r) => r && r.instruction && r.instruction.trim())
      .map((r) => '- ' + (r.label ? `When ${r.label}: ` : '') + r.instruction.trim())
      .join('\n');
    const rulesBlock = rulesText
      ? `\n\nBUSINESS RULES (instructions from the business — always follow them when they apply):\n${rulesText}`
      : '';

    const ctx = contextBlock ? contextBlock : '(no relevant context found)';
    return `${base}\n\n${grounding}${rulesBlock}\n\nContext:\n${ctx}`;
  }
}
