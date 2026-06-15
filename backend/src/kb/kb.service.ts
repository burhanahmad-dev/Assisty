import { Injectable, Logger } from '@nestjs/common';

import { DatabaseService } from '../database/database.service';
import { AiService } from '../ai/ai.service';
import { KbRepository } from '../database/repositories/kb.repository';

export type KbSourceType =
  | 'profile'
  | 'faq'
  | 'catalog'
  | 'policy'
  | 'orders'
  | 'website'
  | 'text';

export interface BusinessProfile {
  name?: string;
  description?: string;
  hours?: string;
  address?: string;
  contact?: string;
  payment?: string;
  website?: string;
  tone?: string;
}
export interface FaqPair {
  q: string;
  a: string;
}
export interface CatalogItem {
  name: string;
  price?: string;
  availability?: string;
  description?: string;
}
export interface PolicyItem {
  title: string;
  body: string;
}
export interface OrderItem {
  orderNumber: string;
  status?: string;
  tracking?: string;
  items?: string;
  total?: string;
  invoice?: string;
}

export interface SaveResult {
  type: KbSourceType;
  chunks: number;
}

const AGENT_INSTRUCTIONS_TYPE = 'agent-instructions';

/**
 * The KB engine: each "info collector" composes its input into retrieval-sized
 * chunks, embeds them (1536-d) and stores them in pgvector (tenant-scoped via
 * DatabaseService.scoped → RLS). Also stores the per-tenant Master Prompt
 * (agent instructions) + Custom Commands (NOT embedded; injected into prompts).
 */
@Injectable()
export class KbService {
  private readonly logger = new Logger(KbService.name);
  private static readonly CHUNK_CHARS = 1500;

  constructor(
    private readonly db: DatabaseService,
    private readonly ai: AiService,
    private readonly kb: KbRepository,
  ) {}

  // ---- Info collectors ------------------------------------------------------

  async saveProfile(tenantId: string, p: BusinessProfile): Promise<SaveResult> {
    const lines: string[] = [];
    if (p.name) lines.push(`Business name: ${p.name}.`);
    if (p.description) lines.push(`About the business: ${p.description}`);
    if (p.hours) lines.push(`Opening hours: ${p.hours}.`);
    if (p.address) lines.push(`Address / location: ${p.address}.`);
    if (p.contact) lines.push(`Contact: ${p.contact}.`);
    if (p.payment) lines.push(`Payment options: ${p.payment}.`);
    if (p.website) lines.push(`Website: ${p.website}.`);
    if (p.tone) lines.push(`Preferred tone of voice: ${p.tone}.`);
    const text = lines.join('\n');
    const title = p.name ? `Profile — ${p.name}` : 'Business profile';
    return this.saveSource(tenantId, 'profile', title, text, this.chunkText(text));
  }

  async saveFaqs(tenantId: string, faqs: FaqPair[]): Promise<SaveResult> {
    const valid = (faqs ?? []).filter((f) => f && f.q?.trim() && f.a?.trim());
    const chunks = valid.map((f) => `Q: ${f.q.trim()}\nA: ${f.a.trim()}`);
    return this.saveSource(tenantId, 'faq', `FAQ (${valid.length})`, chunks.join('\n\n'), chunks);
  }

  async saveCatalog(tenantId: string, products: CatalogItem[]): Promise<SaveResult> {
    const valid = (products ?? []).filter((p) => p && p.name?.trim());
    const chunks = valid.map((p) => {
      const parts = [p.name.trim()];
      if (p.price) parts.push(`Price: ${p.price}`);
      if (p.availability) parts.push(`Availability: ${p.availability}`);
      if (p.description) parts.push(p.description.trim());
      return parts.join(' — ');
    });
    return this.saveSource(tenantId, 'catalog', `Catalog (${valid.length})`, chunks.join('\n'), chunks);
  }

  async savePolicies(tenantId: string, policies: PolicyItem[]): Promise<SaveResult> {
    const valid = (policies ?? []).filter((p) => p && p.body?.trim());
    const chunks = valid.map((p) => `${(p.title || 'Policy').trim()}: ${p.body.trim()}`);
    return this.saveSource(tenantId, 'policy', `Policies (${valid.length})`, chunks.join('\n\n'), chunks);
  }

  /** Orders: one chunk per order so "where is order #1001?" retrieves that order. */
  async saveOrders(tenantId: string, orders: OrderItem[]): Promise<SaveResult> {
    const valid = (orders ?? []).filter((o) => o && o.orderNumber?.trim());
    const chunks = valid.map((o) => {
      const parts = [`Order #${o.orderNumber.trim()}`];
      if (o.status) parts.push(`Status: ${o.status}`);
      if (o.tracking) parts.push(`Tracking number: ${o.tracking}`);
      if (o.items) parts.push(`Items: ${o.items}`);
      if (o.total) parts.push(`Total: ${o.total}`);
      if (o.invoice) parts.push(`Invoice: ${o.invoice}`);
      return parts.join(' — ');
    });
    return this.saveSource(tenantId, 'orders', `Orders (${valid.length})`, chunks.join('\n'), chunks);
  }

  async saveText(tenantId: string, text: string): Promise<SaveResult> {
    const clean = (text ?? '').trim();
    return this.saveSource(tenantId, 'text', 'Free text', clean, this.chunkText(clean));
  }

  async importWebsite(tenantId: string, url: string): Promise<SaveResult & { url: string }> {
    if (!/^https?:\/\//i.test(url)) {
      throw new Error('URL must start with http:// or https://');
    }
    let res: Response;
    try {
      res = await fetch(url, { headers: { 'User-Agent': 'AssistyBot/1.0 (+kb-import)' } });
    } catch {
      throw new Error('Could not reach that URL.');
    }
    if (!res.ok) {
      throw new Error(`The site returned status ${res.status}.`);
    }
    const text = this.htmlToText(await res.text());
    if (!text) {
      throw new Error('No readable text found at that URL (it may be JavaScript-rendered).');
    }
    const result = await this.saveSource(tenantId, 'website', url, text, this.chunkText(text));
    return { ...result, url };
  }

  // ---- Master Prompt (agent instructions) — NOT embedded --------------------

  async saveAgentInstructions(tenantId: string, text: string): Promise<{ saved: boolean }> {
    const clean = (text ?? '').trim();
    await this.db.scoped(tenantId, async (sql) => {
      await sql`DELETE FROM kb_documents WHERE tenant_id = ${tenantId} AND type = ${AGENT_INSTRUCTIONS_TYPE}`;
      if (clean) {
        await sql`
          INSERT INTO kb_documents (tenant_id, type, title, source, status, content, updated_at)
          VALUES (${tenantId}, ${AGENT_INSTRUCTIONS_TYPE}, 'Master prompt', 'web-console', 'approved', ${clean}, now())
        `;
      }
    });
    if (!clean) return { saved: false };
    this.logger.log({ msg: 'kb.agent_instructions.saved', tenantId });
    return { saved: true };
  }

  async getAgentInstructions(tenantId: string): Promise<string> {
    const rows = await this.db.scoped(tenantId, (sql) => sql<{ content: string | null }[]>`
      SELECT content FROM kb_documents
      WHERE tenant_id = ${tenantId} AND type = ${AGENT_INSTRUCTIONS_TYPE}
      ORDER BY updated_at DESC LIMIT 1
    `);
    return rows[0]?.content ?? '';
  }

  /** Custom rules / commands the agent must follow (e.g. post-order screenshot). Not embedded. */
  async saveCustomRules(
    tenantId: string,
    rules: Array<{ label?: string; instruction: string }>,
  ): Promise<{ count: number }> {
    const valid = (rules ?? []).filter((r) => r && r.instruction && r.instruction.trim());
    await this.db.scoped(tenantId, async (sql) => {
      await sql`DELETE FROM kb_documents WHERE tenant_id = ${tenantId} AND type = 'custom-rules'`;
      if (valid.length > 0) {
        await sql`
          INSERT INTO kb_documents (tenant_id, type, title, source, status, content, updated_at)
          VALUES (${tenantId}, 'custom-rules', 'Custom rules', 'web-console', 'approved', ${JSON.stringify(valid)}, now())
        `;
      }
    });
    if (valid.length === 0) return { count: 0 };
    this.logger.log({ msg: 'kb.custom_rules.saved', tenantId, count: valid.length });
    return { count: valid.length };
  }

  async getCustomRules(tenantId: string): Promise<Array<{ label?: string; instruction: string }>> {
    const rows = await this.db.scoped(tenantId, (sql) => sql<{ content: string | null }[]>`
      SELECT content FROM kb_documents
      WHERE tenant_id = ${tenantId} AND type = 'custom-rules'
      ORDER BY updated_at DESC LIMIT 1
    `);
    try {
      const parsed = rows[0]?.content ? JSON.parse(rows[0].content) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  // ---- Source management ----------------------------------------------------

  async listSources(tenantId: string): Promise<
    Array<{ type: string; title: string | null; chunks: number; updatedAt: Date }>
  > {
    return this.db.scoped(tenantId, (sql) => sql<
      { type: string; title: string | null; chunks: number; updatedAt: Date }[]
    >`
      SELECT d.type, d.title, count(c.id)::int AS chunks, max(d.updated_at) AS "updatedAt"
      FROM kb_documents d
      LEFT JOIN kb_chunks c ON c.document_id = d.id
      WHERE d.tenant_id = ${tenantId} AND d.type <> ${AGENT_INSTRUCTIONS_TYPE}
      GROUP BY d.id, d.type, d.title
      ORDER BY max(d.updated_at) DESC
    `);
  }

  async deleteSource(tenantId: string, type: string): Promise<{ type: string; deleted: boolean }> {
    await this.db.scoped(tenantId, (sql) =>
      sql`DELETE FROM kb_documents WHERE tenant_id = ${tenantId} AND type = ${type}`,
    );
    this.logger.log({ msg: 'kb.deleted', tenantId, type });
    return { type, deleted: true };
  }

  // ---- Internals ------------------------------------------------------------

  private async saveSource(
    tenantId: string,
    type: KbSourceType,
    title: string,
    rawContent: string,
    chunks: string[],
  ): Promise<SaveResult> {
    const cleaned = chunks.map((c) => c.trim()).filter((c) => c.length > 0);

    // Replace the existing source doc (delete + insert) in one tenant transaction.
    const documentId = await this.db.scoped(tenantId, async (sql) => {
      await sql`DELETE FROM kb_documents WHERE tenant_id = ${tenantId} AND type = ${type}`;
      if (cleaned.length === 0) return null;
      const doc = await sql<{ id: string }[]>`
        INSERT INTO kb_documents (tenant_id, type, title, source, status, content, updated_at)
        VALUES (${tenantId}, ${type}, ${title}, 'web-console', 'approved', ${rawContent}, now())
        RETURNING id
      `;
      return doc[0].id;
    });

    if (!documentId) {
      this.logger.log({ msg: 'kb.cleared', tenantId, type });
      return { type, chunks: 0 };
    }

    const embeddings = await this.embedAll(cleaned);
    for (let i = 0; i < cleaned.length; i++) {
      await this.kb.insertChunk(tenantId, documentId, cleaned[i], embeddings[i]);
    }

    this.logger.log({ msg: 'kb.saved', tenantId, type, chunks: cleaned.length });
    return { type, chunks: cleaned.length };
  }

  private async embedAll(chunks: string[]): Promise<number[][]> {
    try {
      return await this.ai.embed(chunks);
    } catch (err) {
      this.logger.warn({
        msg: 'kb.embed.batch_failed_fallback_loop',
        error: err instanceof Error ? err.message : String(err),
      });
      const out: number[][] = [];
      for (const c of chunks) {
        out.push(await this.ai.embed(c));
      }
      return out;
    }
  }

  private chunkText(text: string, size = KbService.CHUNK_CHARS): string[] {
    const paras = (text ?? '')
      .replace(/\r/g, '')
      .split(/\n{2,}/)
      .map((s) => s.trim())
      .filter(Boolean);

    const grouped: string[] = [];
    let buf = '';
    for (const para of paras) {
      if (buf && (buf + '\n\n' + para).length > size) {
        grouped.push(buf);
        buf = para;
      } else {
        buf = buf ? `${buf}\n\n${para}` : para;
      }
    }
    if (buf) grouped.push(buf);

    const out: string[] = [];
    for (const c of grouped) {
      if (c.length <= size) out.push(c);
      else for (let i = 0; i < c.length; i += size) out.push(c.slice(i, i + size));
    }
    return out;
  }

  private htmlToText(html: string): string {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 20000);
  }
}
