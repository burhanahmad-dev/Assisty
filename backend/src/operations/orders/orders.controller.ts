import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { OrdersService, type CreateOrderDto } from './orders.service';
import { CurrentTenant } from '../../auth/current-tenant.decorator';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  async list(@CurrentTenant() tenantId: string): Promise<unknown> {
    return this.orders.list(tenantId);
  }

  @Get(':id')
  async get(
    @CurrentTenant() tenantId: string,
    @Param('id') id: string,
  ): Promise<unknown> {
    const order = await this.orders.get(tenantId, id);
    if (!order) throw new NotFoundException('order not found');
    return order;
  }

  @Post()
  async create(
    @CurrentTenant() tenantId: string,
    @Body() body: CreateOrderDto,
  ): Promise<unknown> {
    if (!body?.items?.length) throw new BadRequestException('items are required');
    return this.orders.create(tenantId, body);
  }

  @Patch(':id/status')
  async status(
    @CurrentTenant() tenantId: string,
    @Param('id') id: string,
    @Body() body: { status?: string },
  ): Promise<unknown> {
    if (!body?.status) throw new BadRequestException('status is required');
    return this.orders.updateStatus(tenantId, id, body.status);
  }

  @Patch(':id/payment')
  async payment(
    @CurrentTenant() tenantId: string,
    @Param('id') id: string,
    @Body() body: { paymentStatus?: string },
  ): Promise<unknown> {
    if (!body?.paymentStatus) throw new BadRequestException('paymentStatus is required');
    return this.orders.setPayment(tenantId, id, body.paymentStatus);
  }

  @Patch(':id/ship')
  async ship(
    @CurrentTenant() tenantId: string,
    @Param('id') id: string,
    @Body() body: { trackingNumber?: string; carrier?: string },
  ): Promise<unknown> {
    return this.orders.ship(tenantId, id, body?.trackingNumber, body?.carrier);
  }

  @Patch(':id/cancel')
  async cancel(
    @CurrentTenant() tenantId: string,
    @Param('id') id: string,
  ): Promise<unknown> {
    return this.orders.cancel(tenantId, id);
  }
}
