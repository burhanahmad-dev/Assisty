import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

export interface ProductDto {
  name: string;
  category?: string;
  description?: string;
  price?: number;
  currency?: string;
  stock?: number;
  sizes?: string[];
  colours?: string[];
  imageUrl?: string;
  active?: boolean;
}

export interface ProductRow {
  id: string;
  name: string;
  category: string | null;
  description: string | null;
  price: number;
  currency: string;
  stock: number;
  /** Arbitrary option axes the business defined (e.g. sizes, colours, portions). Business-agnostic. */
  options: Record<string, string[]>;
  imageUrl: string | null;
  active: boolean;
}

const SELECT = `id, name, category, description, price::float8 AS price, currency, stock, options, image_url AS "imageUrl", active`;

/**
 * Structured product catalog (Operations Layer). The truth for product
 * price/stock/options used by Orders and the Suggestion engine — NOT RAG.
 * All access is tenant-scoped via DatabaseService.scoped (RLS-enforced).
 */
@Injectable()
export class CatalogService {
  constructor(private readonly db: DatabaseService) {}

  async list(tenantId: string): Promise<ProductRow[]> {
    return this.db.scoped(tenantId, (sql) => sql<ProductRow[]>`
      SELECT id, name, category, description, price::float8 AS price, currency, stock, options, image_url AS "imageUrl", active
      FROM products WHERE tenant_id = ${tenantId} ORDER BY created_at DESC
    `);
  }

  async create(tenantId: string, d: ProductDto): Promise<ProductRow> {
    const options = { sizes: d.sizes ?? [], colours: d.colours ?? [] };
    return this.db.scoped(tenantId, async (sql) => {
      const rows = await sql<ProductRow[]>`
        INSERT INTO products (tenant_id, name, category, description, price, currency, stock, options, image_url, active)
        VALUES (${tenantId}, ${d.name}, ${d.category ?? null}, ${d.description ?? null}, ${d.price ?? 0},
                ${d.currency ?? 'PKR'}, ${d.stock ?? 0}, ${sql.json(options)}, ${d.imageUrl ?? null}, ${d.active ?? true})
        RETURNING id, name, category, description, price::float8 AS price, currency, stock, options, image_url AS "imageUrl", active
      `;
      return rows[0];
    });
  }

  async update(tenantId: string, id: string, d: ProductDto): Promise<ProductRow | null> {
    const options = { sizes: d.sizes ?? [], colours: d.colours ?? [] };
    return this.db.scoped(tenantId, async (sql) => {
      const rows = await sql<ProductRow[]>`
        UPDATE products SET
          name = ${d.name}, category = ${d.category ?? null}, description = ${d.description ?? null},
          price = ${d.price ?? 0}, currency = ${d.currency ?? 'PKR'}, stock = ${d.stock ?? 0},
          options = ${sql.json(options)}, image_url = ${d.imageUrl ?? null}, active = ${d.active ?? true},
          updated_at = now()
        WHERE id = ${id} AND tenant_id = ${tenantId}
        RETURNING id, name, category, description, price::float8 AS price, currency, stock, options, image_url AS "imageUrl", active
      `;
      return rows[0] ?? null;
    });
  }

  async remove(tenantId: string, id: string): Promise<void> {
    await this.db.scoped(tenantId, (sql) => sql`DELETE FROM products WHERE id = ${id} AND tenant_id = ${tenantId}`);
  }

  /** Lightweight relevance search for the suggestion engine (term-overlap scoring). */
  async search(tenantId: string, query: string, limit = 4): Promise<ProductRow[]> {
    const terms = (query || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
    if (terms.length === 0) return [];
    const rows = await this.db.scoped(tenantId, (sql) => sql<ProductRow[]>`
      SELECT id, name, category, description, price::float8 AS price, currency, stock, options, image_url AS "imageUrl", active
      FROM products WHERE tenant_id = ${tenantId} AND active = true
    `);
    return rows
      .map((p) => {
        const hay = `${p.name} ${p.category ?? ''} ${p.description ?? ''}`.toLowerCase();
        const score = terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
        return { p, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.p);
  }
}

export { SELECT as PRODUCT_SELECT };
