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
}

export interface ChatResult {
  content: string;
  model: string;
  usageTokens: number;
}

/**
 * AiService talks to the LiteLLM proxy using the OpenAI SDK shape.
 *
 * Everything (OpenAI, Gemini, OpenRouter, embeddings, and later Anthropic) is
 * routed through LITELLM_BASE_URL, so this service never needs provider-specific
 * code. Errors are handled defensively with a single retry on transient (429/5xx)
 * failures. We log model + token usage but never the prompt content at info level.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly client: OpenAI;
  private readonly defaultChatModel: string;
  private readonly embeddingModel: string;

  constructor(private readonly config: ConfigService<AppConfig, true>) {
    const litellm = this.config.get('litellm', { infer: true });
    const ai = this.config.get('ai', { infer: true });
    this.client = new OpenAI({
      baseURL: litellm.baseUrl,
      apiKey: litellm.apiKey,
    });
    this.defaultChatModel = ai.defaultChatModel;
    this.embeddingModel = ai.embeddingModel;
  }

  /**
   * Run a chat completion against the resolved model.
   * Returns the assistant content, the model used, and total token usage.
   */
  async chat(params: ChatParams): Promise<ChatResult> {
    const model = resolveChatModel(params.model, this.defaultChatModel);
    const temperature = params.temperature ?? 0.2;

    const completion = await this.withRetry(
      () =>
        this.client.chat.completions.create({
          model,
          temperature,
          messages: params.messages,
        }),
      'chat.completions.create',
      { model },
    );

    const content = completion.choices?.[0]?.message?.content ?? '';
    const usageTokens = completion.usage?.total_tokens ?? 0;

    this.logger.log({
      msg: 'ai.chat.completed',
      model,
      usageTokens,
      promptTokens: completion.usage?.prompt_tokens ?? 0,
      completionTokens: completion.usage?.completion_tokens ?? 0,
    });

    return { content, model, usageTokens };
  }

  /** Embed a single string. Returns a single embedding vector. */
  async embed(input: string): Promise<number[]>;
  /** Embed multiple strings. Returns one vector per input. */
  async embed(input: string[]): Promise<number[][]>;
  async embed(input: string | string[]): Promise<number[] | number[][]> {
    const isBatch = Array.isArray(input);
    const response = await this.withRetry(
      () =>
        this.client.embeddings.create({
          model: this.embeddingModel,
          input,
        }),
      'embeddings.create',
      { model: this.embeddingModel },
    );

    const vectors = response.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding as number[]);

    this.logger.log({
      msg: 'ai.embed.completed',
      model: this.embeddingModel,
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
        this.logger.warn({
          msg: 'ai.retry',
          op,
          ...ctx,
          status: this.statusOf(err),
        });
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
