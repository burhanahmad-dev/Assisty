import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { SettingsService } from '../settings/settings.service';

export interface OrderItemInput {
  name: string;
  qty?: number;
  price?: number;
  size?: string;
  colour?: string;
  /** Generic, business-defined option axes chosen for this line (e.g. { plan: 'Pro' }). */
  options?: Record<string, string>;
  productId?: string;
}
export interface CreateOrderDto {
  customerRef?: string;
  customerName?: string;
  items: OrderItemInput[];
  shippingAddress?: string;
  currency?: string;
}
export interface OrderRow {
  id: string;
  orderNumber: string;
  customerRef: string | null;
  customerName: string | null;
  status: string;
  paymentStatus: string;
  trackingNumber: string | null;
  carrier: string | null;
  shippingAddress: string | null;
  items: OrderItemInput[];
  subtotal: number;
  total: number;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
}

export const ORDER_STATUSES = [
  'pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded',
];
export const PAYMENT_STATUSES = [
  'unpaid', 'pending', 'paid', 'partially_refunded', 'refunded', 'failed',
];

/**
 * Orders (Operations Layer) — relational, exact, transactional. All access is
 * tenant-scoped via DatabaseService.scoped (RLS-enforced). Cancellation is gated
 * by the tenant's settings policy.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly settings: SettingsService,
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private map(r: any): OrderRow {
    return {
      id: r.id,
      orderNumber: r.order_number,
      customerRef: r.customer_ref,
      customerName: r.customer_name,
      status: r.status,
      paymentStatus: r.payment_status,
      trackingNumber: r.tracking_number,
      carrier: r.carrier,
      shippingAddress: r.shipping_address,
      items: (r.items ?? []) as OrderItemInput[],
      subtotal: Number(r.subtotal),
      total: Number(r.total),
      currency: r.currency,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async list(tenantId: string): Promise<OrderRow[]> {
    const rows = await this.db.scoped(tenantId, (sql) =>
      sql`SELECT * FROM orders WHERE tenant_id = ${tenantId} ORDER BY created_at DESC`,
    );
    return rows.map((r) => this.map(r));
  }

  async get(tenantId: string, id: string): Promise<OrderRow | null> {
    const rows = await this.db.scoped(tenantId, (sql) =>
      sql`SELECT * FROM orders WHERE id = ${id} AND tenant_id = ${tenantId} LIMIT 1`,
    );
    return rows[0] ? this.map(rows[0]) : null;
  }

  async getByNumber(tenantId: string, orderNumber: string): Promise<OrderRow | null> {
    const rows = await this.db.scoped(tenantId, (sql) =>
      sql`SELECT * FROM orders WHERE order_number = ${orderNumber} AND tenant_id = ${tenantId} LIMIT 1`,
    );
    return rows[0] ? this.map(rows[0]) : null;
  }

  async recentForCustomer(tenantId: string, customerRef: string, limit = 5): Promise<OrderRow[]> {
    const rows = await this.db.scoped(tenantId, (sql) => sql`
      SELECT * FROM orders WHERE tenant_id = ${tenantId} AND customer_ref = ${customerRef}
      ORDER BY created_at DESC LIMIT ${limit}
    `);
    return rows.map((r) => this.map(r));
  }

  async create(tenantId: string, dto: CreateOrderDto): Promise<OrderRow> {
    const items = (dto.items ?? []).map((i) => ({
      name: String(i.name),
      qty: Number(i.qty ?? 1),
      price: Number(i.price ?? 0),
      size: i.size ?? null,
      colour: i.colour ?? null,
      options: i.options ?? {},
      productId: i.productId ?? null,
    }));
    const subtotal = items.reduce((s, i) => s + i.qty * i.price, 0);
    const settings = await this.settings.get(tenantId);
    const status = settings.autoConfirmOrders ? 'confirmed' : 'pending';
    const currency = dto.currency ?? settings.currency;

    const rows = await this.db.scoped(tenantId, (sql) => sql`
      INSERT INTO orders (tenant_id, customer_ref, customer_name, status, items, subtotal, total, currency, shipping_address)
      VALUES (${tenantId}, ${dto.customerRef ?? null}, ${dto.customerName ?? null}, ${status},
              ${sql.json(items)}, ${subtotal}, ${subtotal}, ${currency}, ${dto.shippingAddress ?? null})
      RETURNING *
    `);
    return this.map(rows[0]);
  }

  async updateStatus(tenantId: string, id: string, status: string): Promise<OrderRow> {
    if (!ORDER_STATUSES.includes(status)) throw new BadRequestException('invalid status');
    const rows = await this.db.scoped(tenantId, (sql) =>
      sql`UPDATE orders SET status = ${status}, updated_at = now() WHERE id = ${id} AND tenant_id = ${tenantId} RETURNING *`,
    );
    if (!rows[0]) throw new NotFoundException('order not found');
    return this.map(rows[0]);
  }

  async setPayment(tenantId: string, id: string, paymentStatus: string): Promise<OrderRow> {
    if (!PAYMENT_STATUSES.includes(paymentStatus)) throw new BadRequestException('invalid payment status');
    const rows = await this.db.scoped(tenantId, (sql) =>
      sql`UPDATE orders SET payment_status = ${paymentStatus}, updated_at = now() WHERE id = ${id} AND tenant_id = ${tenantId} RETURNING *`,
    );
    if (!rows[0]) throw new NotFoundException('order not found');
    return this.map(rows[0]);
  }

  async ship(tenantId: string, id: string, trackingNumber?: string, carrier?: string): Promise<OrderRow> {
    const rows = await this.db.scoped(tenantId, (sql) => sql`
      UPDATE orders SET status = 'shipped', tracking_number = ${trackingNumber ?? null},
        carrier = ${carrier ?? null}, updated_at = now()
      WHERE id = ${id} AND tenant_id = ${tenantId} RETURNING *
    `);
    if (!rows[0]) throw new NotFoundException('order not found');
    return this.map(rows[0]);
  }

  /** Cancellation is policy-gated by tenant settings (operator-configurable). */
  async cancel(tenantId: string, id: string): Promise<OrderRow> {
    const order = await this.get(tenantId, id);
    if (!order) throw new NotFoundException('order not found');
    const settings = await this.settings.get(tenantId);
    if (!settings.cancellableStatuses.includes(order.status)) {
      throw new BadRequestException(
        `Orders in status "${order.status}" can't be cancelled. Allowed: ${settings.cancellableStatuses.join(', ')}.`,
      );
    }
    const rows = await this.db.scoped(tenantId, (sql) =>
      sql`UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = ${id} AND tenant_id = ${tenantId} RETURNING *`,
    );
    return this.map(rows[0]);
  }
}
