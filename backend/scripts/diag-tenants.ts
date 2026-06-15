import './load-env';
import postgres from 'postgres';

async function main(): Promise<void> {
  const sql = postgres(process.env.DATABASE_URL as string, { max: 1, prepare: false });
  try {
    const tenants = await sql`SELECT id, name, created_at FROM tenants ORDER BY created_at ASC`;
    console.log('TENANTS:');
    for (const t of tenants) console.log('  ', t.id, '|', t.name, '|', t.created_at);

    const prods = await sql`SELECT tenant_id, name FROM products`;
    console.log('PRODUCTS:');
    for (const p of prods) console.log('  ', p.tenant_id, '|', p.name);

    const orders = await sql`SELECT tenant_id, order_number, tracking_number, status FROM orders`;
    console.log('ORDERS:');
    for (const o of orders) console.log('  ', o.tenant_id, '|', o.order_number, '|', o.tracking_number, '|', o.status);

    const conns = await sql`SELECT tenant_id, type, external_id FROM channel_connections`;
    console.log('CHANNEL_CONNECTIONS:');
    for (const c of conns) console.log('  ', c.tenant_id, '|', c.type, '|', c.external_id);
  } finally {
    await sql.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
