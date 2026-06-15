import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import type { AppConfig } from '../config/configuration';
import { resolveChatModel } from './ai.models';

/** A single chat turn passed to the model. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatParams {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  /** When true, ask the model to return a single JSON object (response_format). */
  json?: boolean;
}

export interface ChatResult {
  content: string;
  model: string;
  usageTokens: number;
}

/**
 * AiService talks to the configured OpenAI-compatible endpoint (Gemini today,
 * OpenRouter/OpenAI/LiteLLM also supported) via the OpenAI SDK shape.
 *
 * Reliability: one retry on transient (429/5xx) failures; and — only when the
 * provider is OpenRouter — an optional `models` fallback array.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  /**
   * Cap on output tokens per chat call. Support replies are short, and — on
   * OpenRouter — an uncapped request reserves credit for the model's MAX output
   * (e.g. Gemini 2.5 Flash = 65k), which 402s on low-balance accounts. Capping
   * keeps requests affordable and replies snappy.
   */
  private static readonly MAX_OUTPUT_TOKENS = 2048;
  /** Chat client — OpenRouter when configured, else the litellm/Gemini endpoint. */
  private readonly chatClient: OpenAI;
  /** Embeddings client — always litellm (Gemini); OpenRouter has no embeddings endpoint. */
  private readonly embedClient: OpenAI;
  private readonly defaultChatModel: string;
  private readonly fallbackChatModels: string[];
  private readonly embeddingModel: string;
  private readonly embeddingDim: number;
  /** The `models` fallback array is an OpenRouter extension; off for other providers (e.g. Gemini). */
  private readonly isOpenRouter: boolean;

  constructor(private readonly config: ConfigService<AppConfig, true>) {
    const litellm = this.config.get('litellm', { infer: true });
    const openrouter = this.config.get('openrouter', { infer: true });
    const ai = this.config.get('ai', { infer: true });

    // Chat → OpenRouter when an OpenRouter key is configured; otherwise the
    // litellm/Gemini endpoint (backward compatible).
    const useOpenRouter = Boolean(openrouter?.apiKey && openrouter.apiKey.trim());
    const chatBaseUrl = useOpenRouter ? openrouter.baseUrl : litellm.baseUrl;
    const chatApiKey = useOpenRouter ? openrouter.apiKey : litellm.apiKey;
    this.chatClient = new OpenAI({ baseURL: chatBaseUrl, apiKey: chatApiKey });

    // Embeddings ALWAYS use the litellm endpoint (Gemini gemini-embedding-001):
    // OpenRouter has no embeddings endpoint, and the KB vectors are 1536-dim Gemini.
    this.embedClient = new OpenAI({ baseURL: litellm.baseUrl, apiKey: litellm.apiKey });

    this.defaultChatModel = ai.defaultChatModel;
    this.fallbackChatModels = ai.fallbackChatModels ?? [];
    this.embeddingModel = ai.embeddingModel;
    this.embeddingDim = ai.embeddingDim;
    this.isOpenRouter = /openrouter\.ai/i.test(chatBaseUrl);

    this.logger.log({
      msg: 'ai.client.init',
      chatVia: useOpenRouter ? 'openrouter' : 'litellm',
      isOpenRouter: this.isOpenRouter,
    });
  }

  /**
   * Run a chat completion. Returns the assistant content, model used, and total
   * token usage. On OpenRouter, a `models` array auto-routes around a throttled
   * primary (OpenRouter caps it at 3 total).
   */
  async chat(params: ChatParams): Promise<ChatResult> {
    const primary = resolveChatModel(params.model, this.defaultChatModel);
    const temperature = params.temperature ?? 0.2;

    const candidates = [primary, ...this.fallbackChatModels]
      .filter((m, i, arr) => m && arr.indexOf(m) === i)
      .slice(0, 3);

    const buildPayload = (model: string): Record<string, unknown> => {
      const pl: Record<string, unknown> = {
        model,
        temperature,
        messages: params.messages,
        // Cap output so OpenRouter doesn't reserve credit for the model's full
        // max (which 402s low-balance accounts on high-ceiling models like Gemini).
        max_tokens: AiService.MAX_OUTPUT_TOKENS,
      };
      // `models` fallback array is an OpenRouter extension only.
      if (this.isOpenRouter && candidates.length > 1) pl.models = candidates;
      // Structured output: ask for a single JSON object (Gemini/OpenAI honor this).
      if (params.json) pl.response_format = { type: 'json_object' };
      return pl;
    };

    let completion: OpenAI.Chat.ChatCompletion;
    try {
      completion = await this.withRetry<OpenAI.Chat.ChatCompletion>(
        () =>
          this.chatClient.chat.completions.create(
            buildPayload(primary) as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
          ),
        'chat.completions.create',
        { model: primary },
      );
    } catch (err) {
      // On a transient failure (e.g. Gemini free-tier 429), fall back to the
      // next configured model (which has its own quota) before giving up.
      const fb = this.fallbackChatModels.find((m) => m && m !== primary);
      if (!this.isOpenRouter && fb && this.isTransient(err)) {
        this.logger.warn({ msg: 'ai.chat.fallback_model', from: primary, to: fb });
        completion = (await this.chatClient.chat.completions.create(
          buildPayload(fb) as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
        )) as OpenAI.Chat.ChatCompletion;
      } else {
        throw err;
      }
    }

    const content = completion.choices?.[0]?.message?.content ?? '';
    const usedModel = completion.model ?? primary;
    const usageTokens = completion.usage?.total_tokens ?? 0;

    this.logger.log({
      msg: 'ai.chat.completed',
      model: usedModel,
      usageTokens,
      promptTokens: completion.usage?.prompt_tokens ?? 0,
      completionTokens: completion.usage?.completion_tokens ?? 0,
    });

    return { content, model: usedModel, usageTokens };
  }

  /** Embed a single string. Returns a single embedding vector. */
  async embed(input: string): Promise<number[]>;
  /** Embed multiple strings. Returns one vector per input. */
  async embed(input: string[]): Promise<number[][]>;
  async embed(input: string | string[]): Promise<number[] | number[][]> {
    const isBatch = Array.isArray(input);
    const response = await this.withRetry(
      () =>
        this.embedClient.embeddings.create({
          model: this.embeddingModel,
          input,
          // Pin output dimensionality so it matches the pgvector column (1536).
          // Gemini gemini-embedding-001 (and OpenAI text-embedding-3-*) honor this.
          dimensions: this.embeddingDim,
        }),
      'embeddings.create',
      { model: this.embeddingModel, dimensions: this.embeddingDim },
    );

    const vectors = response.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding as number[]);

    this.logger.log({
      msg: 'ai.embed.completed',
      model: this.embeddingModel,
      dimensions: this.embeddingDim,
      count: vectors.length,
      usageTokens: response.usage?.total_tokens ?? 0,
    });

    return isBatch ? vectors : (vectors[0] ?? []);
  }

  /**
   * Execute an OpenAI SDK call with a single retry on transient failures
   * (HTTP 429 or 5xx). Kept intentionally simple for MVP reliability.
   */
  private async withRetry<T>(
    fn: () => Promise<T>,
    op: string,
    ctx: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (this.isTransient(err)) {
        this.logger.warn({ msg: 'ai.retry', op, ...ctx, status: this.statusOf(err) });
        await this.delay(500);
        try {
          return await fn();
        } catch (retryErr) {
          this.logger.error({
            msg: 'ai.failed',
            op,
            ...ctx,
            status: this.statusOf(retryErr),
            error: this.messageOf(retryErr),
          });
          throw retryErr;
        }
      }
      this.logger.error({
        msg: 'ai.failed',
        op,
        ...ctx,
        status: this.statusOf(err),
        error: this.messageOf(err),
      });
      throw err;
    }
  }

  private isTransient(err: unknown): boolean {
    const status = this.statusOf(err);
    return status === 429 || (status >= 500 && status <= 599);
  }

  private statusOf(err: unknown): number {
    if (err instanceof OpenAI.APIError && typeof err.status === 'number') {
      return err.status;
    }
    const status = (err as { status?: unknown })?.status;
    return typeof status === 'number' ? status : 0;
  }

  private messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
