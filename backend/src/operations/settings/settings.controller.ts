import { Body, Controller, Get, Put } from '@nestjs/common';
import { SettingsService, type TenantSettings } from './settings.service';
import { CHAT_MODEL_CATALOG, DEFAULT_CATALOG_MODEL } from '../../ai/ai.models';
import { UsageRepository } from '../../database/repositories/usage.repository';
import { CurrentTenant } from '../../auth/current-tenant.decorator';

@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly usage: UsageRepository,
  ) {}

  @Get()
  async get(@CurrentTenant() tenantId: string): Promise<TenantSettings> {
    return this.settings.get(tenantId);
  }

  /** The selectable chat models (Gemini / OpenAI / DeepSeek via OpenRouter). */
  @Get('models')
  models(): { models: typeof CHAT_MODEL_CATALOG; default: string } {
    return { models: CHAT_MODEL_CATALOG, default: DEFAULT_CATALOG_MODEL };
  }

  /** Per-model usage totals (tokens + messages) for the model usage meter. */
  @Get('usage')
  async usage_(
    @CurrentTenant() tenantId: string,
  ): Promise<{ usage: Array<{ model: string; tokens: number; messages: number }> }> {
    return { usage: await this.usage.byModel(tenantId) };
  }

  @Put()
  async set(
    @CurrentTenant() tenantId: string,
    @Body() body: Partial<TenantSettings>,
  ): Promise<TenantSettings> {
    return this.settings.set(tenantId, body ?? {});
  }
}
