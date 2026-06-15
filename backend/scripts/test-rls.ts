/**
 * RLS isolation test — proves tenant A can NEVER see/modify tenant B's data.
 *
 * Replicates exactly what the app does: open a transaction, `SET LOCAL ROLE
 * assisty_app` + `SET LOCAL app.tenant_id`, then query. Asserts positive access,
 * NEGATIVE cross-tenant reads/writes, and the no-context invariant. Exit 1 on any
 * failure. Run: npm run test:rls
 */
import './load-env';
import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL!;
const sql = postgres(databaseUrl, { max: 1, prepare: false });

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean): void {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}`);
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Tenant-scoped tx, exactly like DatabaseService.scoped(). */
async function scoped(tenantId: string, fn: (tx: any) => Promise<any>): Promise<any> {
  return sql.begin(async (tx: any) => {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    await tx.unsafe('SET LOCAL ROLE assisty_app');
    return fn(tx);
  });
}

/** App role, but NO tenant context set (the invariant case). */
async function noContext(fn: (tx: any) => Promise<any>): Promise<any> {
  return sql.begin(async (tx: any) => {
    await tx.unsafe('SET LOCAL ROLE assisty_app');
    return fn(tx);
  });
}

async function main(): Promise<void> {
  // --- setup as postgres (owner, bypasses RLS) ---
  const [a] = await sql<{ id: string }[]>`INSERT INTO tenants (name) VALUES ('RLS Test A') RETURNING id`;
  const [b] = await sql<{ id: string }[]>`INSERT INTO tenants (name) VALUES ('RLS Test B') RETURNING id`;
  const [pa] = await sql<{ id: string }[]>`INSERT INTO products (tenant_id, name, price) VALUES (${a.id}, 'A-widget', 10) RETURNING id`;
  const [pb] = await sql<{ id: string }[]>`INSERT INTO products (tenant_id, name, price) VALUES (${b.id}, 'B-widget', 20) RETURNING id`;
  console.log(`setup: tenantA=${a.id} tenantB=${b.id}`);

  try {
    // POSITIVE: tenant A sees its own product.
    const aSeesOwn = await scoped(a.id, (tx) => tx`SELECT id FROM products WHERE id = ${pa.id}`);
    check('A can read its own product', aSeesOwn.length === 1);

    // NEGATIVE: tenant A cannot SEE tenant B's product, even by direct id.
    const aSeesB = await scoped(a.id, (tx) => tx`SELECT id FROM products WHERE id = ${pb.id}`);
    check('A CANNOT read B product by id (cross-tenant read blocked)', aSeesB.length === 0);

    // NEGATIVE: A's "list all" only returns A's rows (B excluded).
    const aList = await scoped(a.id, (tx) => tx`SELECT id FROM products`);
    check('A list contains only A rows (B not leaked)', aList.every((r) => r.id !== pb.id) && aList.some((r) => r.id === pa.id));

    // NEGATIVE WRITE: A cannot UPDATE B's product (0 rows affected).
    const upd = await scoped(a.id, (tx) => tx`UPDATE products SET name = 'hacked-by-A' WHERE id = ${pb.id}`);
    check('A UPDATE on B product affects 0 rows', upd.count === 0);

    // NEGATIVE WRITE: A cannot DELETE B's product.
    const del = await scoped(a.id, (tx) => tx`DELETE FROM products WHERE id = ${pb.id}`);
    check('A DELETE on B product affects 0 rows', del.count === 0);

    // NEGATIVE INSERT: A cannot insert a row stamped for tenant B (WITH CHECK).
    let insertBlocked = false;
    try {
      await scoped(a.id, (tx) => tx`INSERT INTO products (tenant_id, name, price) VALUES (${b.id}, 'sneaky', 1)`);
    } catch {
      insertBlocked = true;
    }
    check('A INSERT stamped for B is rejected (WITH CHECK)', insertBlocked);

    // Confirm (as postgres) B's product is untouched.
    const [bRow] = await sql<{ name: string }[]>`SELECT name FROM products WHERE id = ${pb.id}`;
    check('B product is intact after A write attempts', bRow?.name === 'B-widget');

    // POSITIVE other side: B sees B, not A.
    const bSeesOwn = await scoped(b.id, (tx) => tx`SELECT id FROM products WHERE id = ${pb.id}`);
    const bSeesA = await scoped(b.id, (tx) => tx`SELECT id FROM products WHERE id = ${pa.id}`);
    check('B reads its own product', bSeesOwn.length === 1);
    check('B CANNOT read A product (cross-tenant read blocked)', bSeesA.length === 0);

    // INVARIANT: app role with NO tenant context returns ZERO rows.
    const blind = await noContext((tx) => tx`SELECT id FROM products`);
    check('No tenant context -> zero rows (invariant)', blind.length === 0);
  } finally {
    // cleanup as postgres
    await sql`DELETE FROM products WHERE id IN (${pa.id}, ${pb.id})`;
    await sql`DELETE FROM tenants WHERE id IN (${a.id}, ${b.id})`;
  }

  console.log(`\nRLS isolation: ${pass} passed, ${fail} failed`);
  await sql.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('test-rls crashed:', err);
  await sql.end({ timeout: 5 }).catch(() => undefined);
  process.exit(1);
});
