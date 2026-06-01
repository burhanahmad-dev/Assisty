import { Injectable, Logger } from '@nestjs/common';
import {
  KbRepository,
  type KbSearchResult,
} from '../database/repositories/kb.repository';
import { AiService } from '../ai/ai.service';

/**
 * Simple, deterministic RAG for the MVP.
 *
 * Retrieval:  embed the query -> cosine search kb_chunks (tenant-scoped) -> top k.
 * Augment:    build a plain-text context block to inject into the system prompt.
 * Ingest:     naive character-based chunking -> embed -> persist chunks.
 *
 * No re-ranking, no fancy chunking — intentionally trivial and reliable.
 */
@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);

  /** ~500 tokens ≈ ~2000 chars (rough 4 chars/token heuristic). */
  private static readonly CHUNK_SIZE_CHARS = 2000;

  constructor(
    private readonly kb: KbRepository,
    private readonly ai: AiService,
  ) {}

  /**
   * Retrieve the top-k most similar knowledge-base chunks for a query.
   * Tenant scoping is enforced by KbRepository.searchChunks.
   */
  async retrieve(
    tenantId: string,
    query: string,
    k = 5,
  ): Promise<KbSearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    const embedding = await this.ai.embed(trimmed);
    const chunks = await this.kb.searchChunks(tenantId, embedding, k);

    this.logger.log({
      msg: 'rag.retrieve',
      tenantId,
      k,
      hits: chunks.length,
    });

    return chunks;
  }

  /**
   * Turn retrieved chunks into a plain-text context block for the system
   * prompt. Returns "" when there is nothing to ground on, so the caller can
   * decide how to instruct the model about missing context.
   */
  buildContextBlock(chunks: KbSearchResult[]): string {
    if (!chunks.length) {
      return '';
    }
    return chunks
      .map((chunk, i) => `[${i + 1}] ${chunk.content.trim()}`)
      .join('\n\n');
  }

  /**
   * Ingest raw text into the knowledge base for a document: naive chunking,
   * batch-embed, then persist each chunk. Returns the number of chunks stored.
   */
  async ingestText(
    tenantId: string,
    documentId: string,
    text: string,
  ): Promise<number> {
    const chunks = this.chunk(text);
    if (!chunks.length) {
      return 0;
    }

    const embeddings = await this.ai.embed(chunks);

    for (let i = 0; i < chunks.length; i++) {
      await this.kb.insertChunk(tenantId, documentId, chunks[i], embeddings[i]);
    }

    this.logger.log({
      msg: 'rag.ingest',
      tenantId,
      documentId,
      chunks: chunks.length,
    });

    return chunks.length;
  }

  /** Naive fixed-size character chunking. Trivial by design for the MVP. */
  private chunk(text: string): string[] {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return [];
    }

    const out: string[] = [];
    for (
      let i = 0;
      i < normalized.length;
      i += RagService.CHUNK_SIZE_CHARS
    ) {
      const piece = normalized.slice(i, i + RagService.CHUNK_SIZE_CHARS).trim();
      if (piece) {
        out.push(piece);
      }
    }
    return out;
  }
}
