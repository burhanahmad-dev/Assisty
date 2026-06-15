import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

export interface ProductDto {
  name: string;
  category?: string;
  description?: string;
  price?: number;
  currency?: string;
  stock?: number;
  sku?: string;
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
  sku: string | null;
  /** Arbitrary option axes the business defined (e.g. sizes, colours). Business-agnostic. */
  options: Record<string, string[]>;
  imageUrl: string | null;
  active: boolean;
}

const SELECT = `id, name, category, description, price::float8 AS price, currency, stock, sku, options, image_url AS "imageUrl", active`;

/**
 * Structured product catalog (Operations Layer) — the truth for product
 * price/stock/options used by Orders, the suggestion engine, and order
 * verification. All access is tenant-scoped via DatabaseService.scoped (RLS).
 * Product data is kept queryable (not field-encrypted) so the AI can ground on
 * it; tenant isolation + Supabase at-rest encryption protect it.
 */
@Injectable()
export class CatalogService {
  constructor(private readonly db: DatabaseService) {}

  async list(tenantId: string): Promise<ProductRow[]> {
    return this.db.scoped(tenantId, (sql) => sql<ProductRow[]>`
      SELECT id, name, category, description, price::float8 AS price, currency, stock, sku, options, image_url AS "imageUrl", active
      FROM products WHERE tenant_id = ${tenantId} ORDER BY created_at DESC
    `);
  }

  /** Authoritative single-product fetch (real price/stock) — used to verify chat orders. */
  async getById(tenantId: string, id: string): Promise<ProductRow | null> {
    const rows = await this.db.scoped(tenantId, (sql) => sql<ProductRow[]>`
      SELECT id, name, category, description, price::float8 AS price, currency, stock, sku, options, image_url AS "imageUrl", active
      FROM products WHERE id = ${id} AND tenant_id = ${tenantId} LIMIT 1
    `);
    return rows[0] ?? null;
  }

  async create(tenantId: string, d: ProductDto): Promise<ProductRow> {
    const options = { sizes: d.sizes ?? [], colours: d.colours ?? [] };
    return this.db.scoped(tenantId, async (sql) => {
      const rows = await sql<ProductRow[]>`
        INSERT INTO products (tenant_id, name, category, description, price, currency, stock, sku, options, image_url, active)
        VALUES (${tenantId}, ${d.name}, ${d.category ?? null}, ${d.description ?? null}, ${d.price ?? 0},
                ${d.currency ?? 'PKR'}, ${d.stock ?? 0}, ${d.sku ?? null}, ${sql.json(options)}, ${d.imageUrl ?? null}, ${d.active ?? true})
        RETURNING id, name, category, description, price::float8 AS price, currency, stock, sku, options, image_url AS "imageUrl", active
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
          price = ${d.price ?? 0}, currency = ${d.currency ?? 'PKR'}, stock = ${d.stock ?? 0}, sku = ${d.sku ?? null},
          options = ${sql.json(options)}, image_url = ${d.imageUrl ?? null}, active = ${d.active ?? true},
          updated_at = now()
        WHERE id = ${id} AND tenant_id = ${tenantId}
        RETURNING id, name, category, description, price::float8 AS price, currency, stock, sku, options, image_url AS "imageUrl", active
      `;
      return rows[0] ?? null;
    });
  }

  async remove(tenantId: string, id: string): Promise<void> {
    await this.db.scoped(tenantId, (sql) => sql`DELETE FROM products WHERE id = ${id} AND tenant_id = ${tenantId}`);
  }

  /**
   * Bulk import from a spreadsheet (parsed client-side). Upserts by SKU when
   * present (re-import updates), otherwise inserts. One tenant-scoped transaction.
   */
  async importMany(tenantId: string, rows: ProductDto[]): Promise<{ imported: number }> {
    const valid = (rows ?? []).filter((r) => r && r.name && String(r.name).trim());
    if (!valid.length) return { imported: 0 };
    let count = 0;
    await this.db.scoped(tenantId, async (sql) => {
      for (const d of valid) {
        const options = { sizes: d.sizes ?? [], colours: d.colours ?? [] };
        const sku = d.sku ? String(d.sku).trim() : null;
        let updated = 0;
        if (sku) {
          const r = await sql`
            UPDATE products SET name = ${d.name}, category = ${d.category ?? null}, description = ${d.description ?? null},
              price = ${d.price ?? 0}, currency = ${d.currency ?? 'PKR'}, stock = ${d.stock ?? 0},
              options = ${sql.json(options)}, active = ${d.active ?? true}, updated_at = now()
            WHERE tenant_id = ${tenantId} AND sku = ${sku}
          `;
          updated = r.count ?? 0;
        }
        if (!updated) {
          await sql`
            INSERT INTO products (tenant_id, name, category, description, price, currency, stock, sku, options, image_url, active)
            VALUES (${tenantId}, ${d.name}, ${d.category ?? null}, ${d.description ?? null}, ${d.price ?? 0},
                    ${d.currency ?? 'PKR'}, ${d.stock ?? 0}, ${sku}, ${sql.json(options)}, ${d.imageUrl ?? null}, ${d.active ?? true})
          `;
        }
        count++;
      }
    });
    return { imported: count };
  }

  /** Lightweight relevance search for the suggestion engine (term-overlap scoring). */
  async search(tenantId: string, query: string, limit = 4): Promise<ProductRow[]> {
    const terms = (query || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
    if (terms.length === 0) return [];
    const rows = await this.db.scoped(tenantId, (sql) => sql<ProductRow[]>`
      SELECT id, name, category, description, price::float8 AS price, currency, stock, sku, options, image_url AS "imageUrl", active
      FROM products WHERE tenant_id = ${tenantId} AND active = true
    `);
    return rows
      .map((p) => {
        const hay = `${p.name} ${p.category ?? ''} ${p.description ?? ''} ${p.sku ?? ''}`.toLowerCase();
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
