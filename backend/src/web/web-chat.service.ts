import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { DatabaseService } from '../database/database.service';
import { ConversationsRepository } from '../database/repositories/conversations.repository';
import {
  MessagesRepository,
  type MessageRow,
} from '../database/repositories/messages.repository';
import { UsageRepository } from '../database/repositories/usage.repository';
import { RagService } from '../rag/rag.service';
import { AiService, type ChatMessage } from '../ai/ai.service';
import { CommerceService } from './commerce.service';
import { SettingsService } from '../operations/settings/settings.service';
import type { ProductRow } from '../operations/catalog/catalog.service';
import {
  type Suggestions,
  type ModelSuggestion,
  type ModelTurn,
  type AttributePrompt,
  type QuickReply,
  type SuggestedProduct,
  EMPTY_SUGGESTIONS,
} from './suggestion.types';

export const WEB_FALLBACK_REPLY =
  "Sorry — I'm having trouble answering that right now. Please try again in a moment.";

export interface WebChatResult {
  reply: string;
  model: string;
  usedFallback: boolean;
  conversationId: string;
  contextHits: number;
  usageTokens: number;
  suggestions: Suggestions;
}

/**
 * The web conversation brain. On every turn it asks the model for BOTH the
 * human reply AND structured suggestions in one grounded JSON call. It is
 * fully business-agnostic: the "business understanding" comes from THIS
 * tenant's own data (profile, KB, catalog), so suggestions adapt to whatever
 * the business is — never hardcoded to an industry.
 */
@Injectable()
export class WebChatService {
  private readonly logger = new Logger(WebChatService.name);
  private static readonly HISTORY_LIMIT = 10;
  private static readonly WEB_EXTERNAL_ID = 'web-playground';
  private static readonly MAX_CONTEXT_CHARS = 6000;

  constructor(
    private readonly db: DatabaseService,
    private readonly conversations: ConversationsRepository,
    private readonly messages: MessagesRepository,
    private readonly usage: UsageRepository,
    private readonly rag: RagService,
    private readonly ai: AiService,
    private readonly commerce: CommerceService,
    private readonly settings: SettingsService,
  ) {}

  async chat(sessionId: string, text: string, businessContext?: string): Promise<WebChatResult> {
    const session = (sessionId || 'anon').slice(0, 80);
    const message = (text || '').trim();
    const manualContext = (businessContext || '').trim().slice(0, WebChatService.MAX_CONTEXT_CHARS);

    const tenantId = await this.ensureTenant();
    const connectionId = await this.ensureWebConnection(tenantId);
    const conversation = await this.conversations.findOrCreate(tenantId, connectionId, session);

    await this.messages.insertInbound({
      tenantId,
      conversationId: conversation.id,
      channelMessageId: `web:${randomUUID()}`,
      content: message,
    });

    // Grounding: RAG (fuzzy knowledge) + Commerce (real orders + catalog candidates).
    const chunks = await this.rag.retrieve(tenantId, message);
    const ragContext = this.rag.buildContextBlock(chunks);
    const commerce = await this.commerce.build(tenantId, message, session);
    const businessInfo = [manualContext, ragContext, commerce.contextText].filter((c) => c).join('\n\n');

    let instructions = await this.getAgentInstructions(tenantId);
    // Custom business rules / commands — appended to the persona so the agent follows them.
    const ruleRows = await this.db.scoped(tenantId, (sql) => sql<{ content: string | null }[]>`
      SELECT content FROM kb_documents WHERE tenant_id = ${tenantId} AND type = 'custom-rules' ORDER BY updated_at DESC LIMIT 1
    `);
    let rulesText = '';
    try {
      const parsed = ruleRows[0]?.content ? JSON.parse(ruleRows[0].content) : [];
      if (Array.isArray(parsed)) {
        rulesText = parsed
          .filter((r: { instruction?: string }) => r && r.instruction)
          .map((r: { label?: string; instruction: string }) => '- ' + (r.label ? `When ${r.label}: ` : '') + r.instruction)
          .join('\n');
      }
    } catch {
      rulesText = '';
    }
    if (rulesText) {
      const base =
        instructions && instructions.trim()
          ? instructions.trim()
          : 'You are the customer-support assistant for this business — warm, human, and genuinely helpful.';
      instructions = base + '\n\nBUSINESS RULES (instructions from the business — follow them whenever they apply):\n' + rulesText;
    }

    const history = await this.messages.recentByConversation(tenantId, conversation.id, WebChatService.HISTORY_LIMIT);
    const promptMessages = this.buildMessages(businessInfo, history, message, instructions);

    // Per-tenant model selection (operator-chosen in Settings). Empty → system default.
    const tenantSettings = await this.settings.get(tenantId);
    const selectedModel =
      tenantSettings.model && tenantSettings.model.trim() ? tenantSettings.model.trim() : undefined;

    let reply: string;
    let model = 'fallback';
    let usageTokens = 0;
    let usedFallback = false;
    let modelSugg: ModelSuggestion = {};

    try {
      // ONE combined structured call → { reply, suggestions }.
      const result = await this.ai.chat({ messages: promptMessages, json: true, model: selectedModel });
      const parsed = this.parseTurn(result.content);
      reply = parsed.reply.trim();
      if (!reply) throw new Error('AI returned no reply field');
      modelSugg = parsed.suggestions;
      model = result.model;
      usageTokens = result.usageTokens;
    } catch (err) {
      this.logger.error({
        msg: 'web.chat.ai_failed',
        session,
        error: err instanceof Error ? err.message : String(err),
      });
      reply = WEB_FALLBACK_REPLY;
      usedFallback = true;
    }

    // Ground the model's picks against the REAL catalog; never trust invented data.
    const suggestions = usedFallback
      ? EMPTY_SUGGESTIONS
      : this.groundSuggestions(modelSugg, commerce.candidates);

    await this.messages.insertOutbound({
      tenantId,
      conversationId: conversation.id,
      content: reply,
      model,
      tokens: usageTokens,
    });

    try {
      await this.usage.record(tenantId, 'ai_tokens', usageTokens, model);
      await this.usage.record(tenantId, 'messages', 1, model);
    } catch (usageErr) {
      this.logger.warn({
        msg: 'web.chat.usage_failed',
        error: usageErr instanceof Error ? usageErr.message : String(usageErr),
      });
    }

    this.logger.log({
      msg: 'web.chat.done',
      session,
      model,
      usedFallback,
      contextHits: chunks.length,
      products: suggestions.products.length,
      chips: suggestions.quickReplies.length + suggestions.attributePrompts.length,
    });

    return {
      reply,
      model,
      usedFallback,
      conversationId: conversation.id,
      contextHits: chunks.length,
      usageTokens,
      suggestions,
    };
  }

  async listMessages(
    sessionId: string,
  ): Promise<Array<{ direction: string; content: string | null; model: string | null }>> {
    const session = (sessionId || 'anon').slice(0, 80);
    const tenantId = await this.ensureTenant();
    return this.db.scoped(tenantId, (sql) => sql<
      { direction: string; content: string | null; model: string | null }[]
    >`
      SELECT m.direction, m.content, m.model
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      JOIN channel_connections cc ON cc.id = c.channel_connection_id
      WHERE cc.type = 'web'
        AND cc.external_id = ${WebChatService.WEB_EXTERNAL_ID}
        AND c.customer_external_id = ${session}
      ORDER BY m.created_at ASC
      LIMIT 50
    `);
  }

  // ---- Suggestion grounding -------------------------------------------------

  /**
   * Map the model's raw picks onto REAL data:
   *  - products: only ids that exist in the candidate set (no invention).
   *  - attributePrompts: kept generic, but if the attribute maps to a real
   *    option axis of the surfaced product, use the REAL option values.
   *  - quickReplies: sanitised + capped.
   */
  private groundSuggestions(sugg: ModelSuggestion, candidates: ProductRow[]): Suggestions {
    const byId = new Map(candidates.map((p) => [p.id, p]));

    const products: SuggestedProduct[] = [];
    for (const id of sugg.productIds ?? []) {
      const p = byId.get(id);
      if (p && !products.some((x) => x.productId === p.id)) {
        products.push({
          productId: p.id,
          name: p.name,
          price: p.price,
          currency: p.currency,
          inStock: p.stock > 0,
          options: this.cleanOptions(p.options),
        });
      }
    }

    const primary = products[0] ? byId.get(products[0].productId) : undefined;
    const attributePrompts: AttributePrompt[] = [];
    for (const ap of sugg.attributePrompts ?? []) {
      const attribute = String(ap?.attribute ?? '').trim().slice(0, 40);
      if (!attribute) continue;
      let options = Array.isArray(ap?.options)
        ? ap!.options!.map((o) => String(o).trim()).filter(Boolean).slice(0, 12)
        : [];
      // Ground option values against the catalog when this attribute is a real axis.
      const real = primary ? this.matchOptionAxis(primary.options, attribute) : undefined;
      if (real && real.length) options = real;
      if (options.length) attributePrompts.push({ attribute, options });
    }

    const quickReplies: QuickReply[] = (Array.isArray(sugg.quickReplies) ? sugg.quickReplies : [])
      .map((q) => ({
        label: String(q?.label ?? '').trim().slice(0, 30),
        action: String(q?.action ?? 'reply').slice(0, 30),
        payload: q?.payload,
      }))
      .filter((q) => q.label)
      .slice(0, 4);

    return { products, quickReplies, attributePrompts };
  }

  private cleanOptions(options: Record<string, string[]> | null | undefined): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    if (!options) return out;
    for (const [k, v] of Object.entries(options)) {
      if (Array.isArray(v) && v.length > 0) out[k] = v.map((x) => String(x));
    }
    return out;
  }

  /** Find a real option axis whose name matches the model's attribute (loose, plural-insensitive). */
  private matchOptionAxis(options: Record<string, string[]>, attribute: string): string[] | undefined {
    const norm = (s: string) => s.toLowerCase().replace(/s$/, '');
    const a = norm(attribute);
    for (const [k, v] of Object.entries(options)) {
      if ((norm(k) === a || k.toLowerCase() === attribute.toLowerCase()) && Array.isArray(v)) return v;
    }
    return undefined;
  }

  /** Tolerantly parse the model's JSON turn (strips code fences / surrounding prose). */
  private parseTurn(content: string): ModelTurn {
    let txt = (content || '').trim();
    txt = txt.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const start = txt.indexOf('{');
    const end = txt.lastIndexOf('}');
    if (start >= 0 && end > start) txt = txt.slice(start, end + 1);
    const obj = JSON.parse(txt) as { reply?: unknown; suggestions?: unknown };
    const reply = typeof obj.reply === 'string' ? obj.reply : '';
    const suggestions =
      obj.suggestions && typeof obj.suggestions === 'object'
        ? (obj.suggestions as ModelSuggestion)
        : {};
    return { reply, suggestions };
  }

  // ---- Prompt assembly ------------------------------------------------------

  private async getAgentInstructions(tenantId: string): Promise<string> {
    const rows = await this.db.scoped(tenantId, (sql) => sql<{ content: string | null }[]>`
      SELECT content FROM kb_documents
      WHERE tenant_id = ${tenantId} AND type = 'agent-instructions'
      ORDER BY updated_at DESC LIMIT 1
    `);
    return rows[0]?.content ?? '';
  }

  private buildMessages(
    businessInfo: string,
    history: MessageRow[],
    userText: string,
    instructions: string,
  ): ChatMessage[] {
    const messages: ChatMessage[] = [{ role: 'system', content: this.systemPrompt(businessInfo, instructions) }];
    for (const msg of history) {
      messages.push({
        role: msg.direction === 'inbound' ? 'user' : 'assistant',
        content: msg.content,
      });
    }
    messages.push({ role: 'user', content: userText });
    return messages;
  }

  private systemPrompt(businessInfo: string, instructions: string): string {
    const persona =
      instructions && instructions.trim()
        ? instructions.trim()
        : 'You are the customer-support assistant for this business — warm, human, and genuinely helpful.';

    const style = [
      'HOW YOU TALK (sound like a real human support rep, never a bot):',
      "- Text like a friendly human teammate: short, warm and natural. Use everyday contractions like you're, we'll, it's.",
      '- Greet ONLY at the very start. If earlier messages exist, do not say hi again — just continue.',
      '- Do not bolt a canned closing line onto every reply. Only ask a follow-up when it genuinely moves things forward.',
      '- Answer the real question first, in about 1 to 3 short sentences. Add more only if asked.',
      "- Speak AS the business using we and our. Vary your wording. Mirror the customer's language and energy.",
    ].join('\n');

    const grounding = [
      'STAY ACCURATE & GROUNDED:',
      '- This assistant serves ANY kind of business. Work out what THIS business does from the business information below — never assume an industry.',
      '- Use ONLY the business information below for facts (services, products, prices, hours, policies, orders). Never invent any.',
      '- For order / tracking / payment / invoice questions, use ONLY the "LIVE ORDER DATA" section if present; if it is absent, ask for the order number.',
      "- If you don't have something, say so briefly and offer to take a message or bring in a human.",
    ].join('\n');

    const output = [
      'OUTPUT FORMAT (STRICT): reply with a SINGLE JSON object and nothing else — no markdown, no code fences:',
      '{',
      '  "reply": "<the message the customer sees — obey ALL the style rules above>",',
      '  "suggestions": {',
      '    "productIds": ["<id copied verbatim from AVAILABLE PRODUCTS that is genuinely relevant>"],',
      '    "attributePrompts": [ { "attribute": "<next detail to ask, named for THIS business>", "options": ["<choice>"] } ],',
      '    "quickReplies": [ { "label": "<short tappable next step>" } ]',
      '  }',
      '}',
      'MAKING SUGGESTIONS PROFESSIONAL (adapt EVERYTHING to THIS business — never hardcode an industry):',
      "- Read the WHOLE conversation + business info to predict the customer's next step.",
      '- productIds: ONLY ids from AVAILABLE PRODUCTS, only when relevant. Use [] if there is no catalog or none fit.',
      '- attributePrompts: when the customer is choosing something that has options, ask the next relevant detail and name it in the business\'s OWN words — e.g. a clothing shop "size"/"colour", a restaurant "party size"/"seating", a salon "service"/"time", software "plan". Use the item\'s real options when available; [] if nothing to ask.',
      '- quickReplies: 2-4 short next steps fitting THIS business and moment (e.g. "Place order", "Book a table", "See pricing", "Track my order", "Talk to a human"). Always give at least one.',
      '- NEVER invent products, prices, stock, options, or order details.',
    ].join('\n');

    const info =
      businessInfo && businessInfo.trim()
        ? businessInfo.trim()
        : 'No business details have been added yet. Stay warm and human, help with what you can, or offer to take a message for the team.';

    return persona + '\n\n' + style + '\n\n' + grounding + '\n\n' + output + '\n\nBusiness information:\n' + info;
  }

  private async ensureTenant(): Promise<string> {
    const existing = await this.db.sql<{ id: string }[]>`SELECT id FROM tenants ORDER BY created_at ASC LIMIT 1`;
    if (existing.length > 0) return existing[0].id;
    const created = await this.db.sql<{ id: string }[]>`INSERT INTO tenants (name) VALUES ('Web Playground Tenant') RETURNING id`;
    return created[0].id;
  }

  private async ensureWebConnection(tenantId: string): Promise<string> {
    await this.db.sql`
      INSERT INTO channel_connections (tenant_id, type, external_id, status)
      VALUES (${tenantId}, 'web', ${WebChatService.WEB_EXTERNAL_ID}, 'active')
      ON CONFLICT (type, external_id) DO NOTHING
    `;
    const rows = await this.db.sql<{ id: string }[]>`
      SELECT id FROM channel_connections WHERE type = 'web' AND external_id = ${WebChatService.WEB_EXTERNAL_ID} LIMIT 1
    `;
    return rows[0].id;
  }
}
