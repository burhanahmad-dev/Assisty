import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { CatalogService, type ProductDto } from './catalog.service';
import { CurrentTenant } from '../../auth/current-tenant.decorator';

@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('products')
  async list(@CurrentTenant() tenantId: string): Promise<unknown> {
    return this.catalog.list(tenantId);
  }

  /** Bulk import products from a spreadsheet (parsed client-side into rows). */
  @Post('import')
  async import(
    @CurrentTenant() tenantId: string,
    @Body() body: { products?: ProductDto[] },
  ): Promise<unknown> {
    return this.catalog.importMany(tenantId, body?.products ?? []);
  }

  @Post('products')
  async create(
    @CurrentTenant() tenantId: string,
    @Body() body: ProductDto,
  ): Promise<unknown> {
    if (!body?.name?.trim()) throw new BadRequestException('name is required');
    return this.catalog.create(tenantId, body);
  }

  @Put('products/:id')
  async update(
    @CurrentTenant() tenantId: string,
    @Param('id') id: string,
    @Body() body: ProductDto,
  ): Promise<unknown> {
    if (!body?.name?.trim()) throw new BadRequestException('name is required');
    const row = await this.catalog.update(tenantId, id, body);
    if (!row) throw new NotFoundException('product not found');
    return row;
  }

  @Delete('products/:id')
  async remove(
    @CurrentTenant() tenantId: string,
    @Param('id') id: string,
  ): Promise<unknown> {
    await this.catalog.remove(tenantId, id);
    return { deleted: true };
  }
}
