/**
 * Helpers for working with pgvector values over postgres.js.
 *
 * pgvector accepts a text literal of the form "[0.1,0.2,0.3]". postgres.js has
 * no native binding for the vector type, so we serialise a JS number[] into
 * that literal and cast it in SQL with `::vector`, e.g.
 *
 *   const lit = toVectorLiteral(embedding);
 *   await sql`... ORDER BY embedding <=> ${lit}::vector ...`;
 *
 * The literal is passed as a normal bound parameter (so it is still safe), and
 * the `::vector` cast lives in the query text.
 */
export function toVectorLiteral(embedding: number[]): string {
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error('toVectorLiteral: embedding must be a non-empty number[]');
  }

  for (const value of embedding) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('toVectorLiteral: embedding contains a non-finite number');
    }
  }

  return `[${embedding.join(',')}]`;
}
