import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { toVectorLiteral } from '../vector.util';

export interface KbSearchResult {
  content: string;
  similarity: number;
}

export interface KbChunkRow {
  id: string;
  tenantId: string;
  documentId: string;
  content: string;
  createdAt: Date;
}

@Injectable()
export class KbRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Cosine-similarity search over kb_chunks, scoped to the tenant.
   *
   * pgvector's `<=>` is cosine DISTANCE (0 = identical), so similarity is
   * 1 - distance. The embedding is serialised to a vector literal and cast with
   * `::vector` (see vector.util). Results are ordered by ascending distance and
   * limited to k.
   */
  async searchChunks(
    tenantId: string,
    embedding: number[],
    k: number,
  ): Promise<KbSearchResult[]> {
    const literal = toVectorLiteral(embedding);
    const rows = await this.db.sql<KbSearchResult[]>`
      SELECT
        content,
        1 - (embedding <=> ${literal}::vector) AS similarity
      FROM kb_chunks
      WHERE tenant_id = ${tenantId}
      ORDER BY embedding <=> ${literal}::vector ASC
      LIMIT ${k}
    `;
    return rows;
  }

  async insertChunk(
    tenantId: string,
    documentId: string,
    content: string,
    embedding: number[],
  ): Promise<KbChunkRow> {
    const literal = toVectorLiteral(embedding);
    const rows = await this.db.sql<KbChunkRow[]>`
      INSERT INTO kb_chunks (tenant_id, document_id, content, embedding)
      VALUES (${tenantId}, ${documentId}, ${content}, ${literal}::vector)
      RETURNING
        id,
        tenant_id   AS "tenantId",
        document_id AS "documentId",
        content,
        created_at  AS "createdAt"
    `;
    return rows[0];
  }
}
