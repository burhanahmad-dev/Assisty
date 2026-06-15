import { Injectable, Logger } from '@nestjs/common';
import { CatalogService, type ProductRow } from '../operations/catalog/catalog.service';
import { OrdersService, type OrderRow } from '../operations/orders/orders.service';

export interface CommerceContext {
  /** Grounding text for the system prompt (live orders + the real catalog). */
  contextText: string;
  /** Real catalog rows the model may surface by id. Empty for non-catalog businesses. */
  candidates: ProductRow[];
}

/**
 * Gathers GROUNDING for the suggestion engine — business-agnostic.
 * It pulls real order rows (when an order is referenced) and candidate catalog
 * rows (only if this tenant has a catalog). It makes NO assumption about the
 * industry; the model decides what is relevant. The catalog's option axes are
 * read generically (whatever keys the business defined), never as size/colour.
 */
@Injectable()
export class CommerceService {
  private readonly logger = new Logger(CommerceService.name);

  constructor(
    private readonly catalog: CatalogService,
    private readonly orders: OrdersService,
  ) {}

  async build(tenantId: string, message: string, customerRef: string): Promise<CommerceContext> {
    const parts: string[] = [];
    const lower = (message || '').toLowerCase();

    // 1) Orders — authoritative relational data when an order is referenced.
    const wantsOrder = /\border\b|\btrack|\bdeliver|\bshipment|\bparcel|where.?s my|status of my/.test(lower);
    const numMatch = message.match(/#?\b(\d{3,})\b/);
    let orders: OrderRow[] = [];
    try {
      if (numMatch) {
        const o = await this.orders.getByNumber(tenantId, numMatch[1]);
        if (o) orders = [o];
      }
      if (orders.length === 0 && wantsOrder && customerRef) {
        orders = await this.orders.recentForCustomer(tenantId, customerRef, 3);
      }
    } catch (err) {
      this.logger.warn({ msg: 'commerce.order_fetch_failed', error: err instanceof Error ? err.message : String(err) });
    }
    if (orders.length > 0) {
      parts.push(
        'LIVE ORDER DATA (authoritative — use ONLY this for any order, tracking, payment or invoice question):',
      );
      for (const o of orders) {
        const items = (o.items ?? []).map((i) => `${i.qty ?? 1}x ${i.name}`).join(', ');
        parts.push(
          `Order #${o.orderNumber}: status ${o.status}, payment ${o.paymentStatus}` +
            (o.trackingNumber ? `, tracking ${o.trackingNumber} via ${o.carrier ?? 'courier'}` : '') +
            `, total ${o.currency} ${o.total}` +
            (items ? `, items: ${items}` : ''),
        );
      }
    }

    // 2) Catalog candidates — only if this tenant actually has a catalog.
    let candidates = await this.catalog.search(tenantId, message, 6).catch((): ProductRow[] => []);
    if (candidates.length === 0) {
      candidates = (await this.catalog.list(tenantId).catch((): ProductRow[] => []))
        .filter((p) => p.active)
        .slice(0, 6);
    }
    if (candidates.length > 0) {
      parts.push(
        'AVAILABLE PRODUCTS/SERVICES (the ONLY items you may recommend — never invent any; use these exact ' +
          'names/prices). Format: "[id] name (category) — price — stock — option-axes". Surface an item by its [id].',
      );
      for (const p of candidates) {
        const opts = this.describeOptions(p.options);
        parts.push(
          `[${p.id}] ${p.name}${p.category ? ` (${p.category})` : ''} — ${p.currency} ${p.price} — ` +
            `${p.stock > 0 ? `stock ${p.stock}` : 'OUT OF STOCK'}` +
            (opts ? ` — ${opts}` : ''),
        );
      }
    }

    return { contextText: parts.join('\n'), candidates };
  }

  /** Serialise arbitrary option axes generically — no size/colour assumptions. */
  private describeOptions(options: Record<string, string[]> | null | undefined): string {
    if (!options) return '';
    const pairs: string[] = [];
    for (const [key, values] of Object.entries(options)) {
      if (Array.isArray(values) && values.length > 0) pairs.push(`${key}: ${values.join(', ')}`);
    }
    return pairs.join('; ');
  }
}
