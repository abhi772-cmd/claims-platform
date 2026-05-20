import {
  CreateRoomCategoryRequestSchema,
  Permissions,
  type RoomCategory,
  type RoomCategoryListResponse,
  type RoomCategoryPayerRate,
  type RoomCategoryPayerRateListResponse,
  UpdateRoomCategoryRequestSchema,
  UpsertRoomCategoryPayerRateRequestSchema,
} from '@claims/contracts';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { RoomCategoryService } from './room-category.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('room-category')
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class RoomCategoryController {
  constructor(private readonly service: RoomCategoryService) {}

  // ── Intake-facing read ─────────────────────────────────────────
  // GET /room-categories?payerCode=STAR_HEALTH
  // CASE_CREATE so every intake operator can populate the dropdown.

  @Get('room-categories')
  @RequirePermission(Permissions.CASE_CREATE)
  async list(
    @CurrentUser() user: Express.AuthenticatedUser,
    @Query('payerCode') payerCode?: string,
  ): Promise<RoomCategoryListResponse> {
    const categories = await this.service.listResolved(
      user.tenantId,
      payerCode?.trim() ? payerCode.trim() : null,
    );
    return { categories };
  }

  // ── Admin endpoints ────────────────────────────────────────────
  // /admin/room-categories — TENANT_ONBOARDING_UPDATE-gated.

  @Get('admin/room-categories')
  @RequirePermission(Permissions.TENANT_ONBOARDING_UPDATE)
  async listAdmin(
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<{ categories: RoomCategory[] }> {
    const categories = await this.service.listAll(user.tenantId);
    return { categories };
  }

  @Post('admin/room-categories')
  @RequirePermission(Permissions.TENANT_ONBOARDING_UPDATE)
  async create(
    @CurrentUser() user: Express.AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<RoomCategory> {
    const parsed = CreateRoomCategoryRequestSchema.safeParse(body);
    if (!parsed.success) throw fromZod(parsed.error);
    return this.service.create(user.tenantId, parsed.data);
  }

  @Patch('admin/room-categories/:id')
  @RequirePermission(Permissions.TENANT_ONBOARDING_UPDATE)
  async update(
    @CurrentUser() user: Express.AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ): Promise<RoomCategory> {
    const parsed = UpdateRoomCategoryRequestSchema.safeParse(body);
    if (!parsed.success) throw fromZod(parsed.error);
    return this.service.update(user.tenantId, id, parsed.data);
  }

  @Delete('admin/room-categories/:id')
  @HttpCode(204)
  @RequirePermission(Permissions.TENANT_ONBOARDING_UPDATE)
  async deactivate(
    @CurrentUser() user: Express.AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.service.deactivate(user.tenantId, id);
  }

  // ── Per-payer overrides ────────────────────────────────────────

  @Get('admin/room-categories/:id/payer-rates')
  @RequirePermission(Permissions.TENANT_ONBOARDING_UPDATE)
  async listPayerRates(
    @CurrentUser() user: Express.AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<RoomCategoryPayerRateListResponse> {
    const rates = await this.service.listPayerRates(user.tenantId, id);
    return { rates };
  }

  // PUT (not POST) because the natural key is (category, payerCode)
  // and the operation is idempotent — admin "sets the Star Health
  // rate to ₹9,500" without caring whether it existed before.
  @Put('admin/room-categories/:id/payer-rates')
  @RequirePermission(Permissions.TENANT_ONBOARDING_UPDATE)
  async upsertPayerRate(
    @CurrentUser() user: Express.AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ): Promise<RoomCategoryPayerRate> {
    const parsed = UpsertRoomCategoryPayerRateRequestSchema.safeParse(body);
    if (!parsed.success) throw fromZod(parsed.error);
    return this.service.upsertPayerRate(user.tenantId, id, parsed.data);
  }

  @Delete('admin/room-categories/:id/payer-rates/:payerCode')
  @HttpCode(204)
  @RequirePermission(Permissions.TENANT_ONBOARDING_UPDATE)
  async deletePayerRate(
    @CurrentUser() user: Express.AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('payerCode') payerCode: string,
  ): Promise<void> {
    await this.service.deletePayerRate(user.tenantId, id, payerCode);
  }
}

function fromZod(err: { issues: { path: (string | number)[]; message: string }[] }): ValidationFailedError {
  const out: Record<string, string[]> = {};
  for (const i of err.issues) {
    const key = i.path.join('.') || '_';
    (out[key] ??= []).push(i.message);
  }
  return new ValidationFailedError(out);
}
