import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
} from '@nestjs/common';

import {
  KbService,
  type BusinessProfile,
  type CatalogItem,
  type FaqPair,
  type OrderItem,
  type PolicyItem,
} from './kb.service';
import { CurrentTenant } from '../auth/current-tenant.decorator';

/**
 * Knowledge Base / Data Sources API. Each collector composes input -> chunks ->
 * Gemini embeddings -> pgvector. Also manages the per-tenant Master Prompt
 * (agent instructions) and Custom Commands (Agent Memory). Tenant comes from the
 * authenticated operator (AuthGuard), never the request body.
 */
@Controller('kb')
export class KbController {
  constructor(private readonly kb: KbService) {}

  @Post('profile')
  async profile(
    @CurrentTenant() tenantId: string,
    @Body() body: BusinessProfile,
  ): Promise<unknown> {
    return this.kb.saveProfile(tenantId, body ?? {});
  }

  @Post('faq')
  async faq(
    @CurrentTenant() tenantId: string,
    @Body() body: { faqs?: FaqPair[] },
  ): Promise<unknown> {
    return this.kb.saveFaqs(tenantId, body?.faqs ?? []);
  }

  @Post('catalog')
  async catalog(
    @CurrentTenant() tenantId: string,
    @Body() body: { products?: CatalogItem[] },
  ): Promise<unknown> {
    return this.kb.saveCatalog(tenantId, body?.products ?? []);
  }

  @Post('policies')
  async policies(
    @CurrentTenant() tenantId: string,
    @Body() body: { policies?: PolicyItem[] },
  ): Promise<unknown> {
    return this.kb.savePolicies(tenantId, body?.policies ?? []);
  }

  @Post('orders')
  async orders(
    @CurrentTenant() tenantId: string,
    @Body() body: { orders?: OrderItem[] },
  ): Promise<unknown> {
    return this.kb.saveOrders(tenantId, body?.orders ?? []);
  }

  @Post('text')
  async text(
    @CurrentTenant() tenantId: string,
    @Body() body: { text?: string },
  ): Promise<unknown> {
    return this.kb.saveText(tenantId, body?.text ?? '');
  }

  @Post('website')
  async website(
    @CurrentTenant() tenantId: string,
    @Body() body: { url?: string },
  ): Promise<unknown> {
    if (!body?.url?.trim()) throw new BadRequestException('url is required');
    try {
      return await this.kb.importWebsite(tenantId, body.url.trim());
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : 'website import failed',
      );
    }
  }

  /** Master Prompt — sets the agent's role/tone (not embedded). */
  @Post('agent')
  async setAgent(
    @CurrentTenant() tenantId: string,
    @Body() body: { instructions?: string },
  ): Promise<unknown> {
    return this.kb.saveAgentInstructions(tenantId, body?.instructions ?? '');
  }

  @Get('agent')
  async getAgent(
    @CurrentTenant() tenantId: string,
  ): Promise<{ instructions: string }> {
    return { instructions: await this.kb.getAgentInstructions(tenantId) };
  }

  /**
   * Custom Commands / "Agent Memory" — standing per-tenant rules the agent
   * ALWAYS follows (e.g. "after payment, ask for the screenshot + TID").
   */
  @Post('rules')
  async setRules(
    @CurrentTenant() tenantId: string,
    @Body() body: { rules?: Array<{ label?: string; instruction: string }> },
  ): Promise<unknown> {
    return this.kb.saveCustomRules(tenantId, body?.rules ?? []);
  }

  @Get('rules')
  async getRules(
    @CurrentTenant() tenantId: string,
  ): Promise<{ rules: Array<{ label?: string; instruction: string }> }> {
    return { rules: await this.kb.getCustomRules(tenantId) };
  }

  @Get('sources')
  async sources(@CurrentTenant() tenantId: string): Promise<unknown> {
    return this.kb.listSources(tenantId);
  }

  @Delete(':type')
  async remove(
    @CurrentTenant() tenantId: string,
    @Param('type') type: string,
  ): Promise<unknown> {
    return this.kb.deleteSource(tenantId, type);
  }
}
