import {
  type CreateTenantRequest,
  CreateTenantRequestSchema,
  type CreateTenantResponse,
  Permissions,
  type ResendPrimaryInviteResponse,
  type TenantAdminDetailResponse,
  type TenantAdminListResponse,
} from '@claims/contracts';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Request } from 'express';

import { TenantAdminService } from './tenant-admin.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('admin-tenants')
@Controller('admin/tenants')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TenantAdminController {
  constructor(private readonly svc: TenantAdminService) {}

  @Get()
  @RequirePermission(Permissions.TENANT_CREATE)
  async list(): Promise<TenantAdminListResponse> {
    return this.svc.list();
  }

  @Get(':tenantId')
  @RequirePermission(Permissions.TENANT_CREATE)
  async detail(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
  ): Promise<TenantAdminDetailResponse> {
    return this.svc.detail(tenantId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission(Permissions.TENANT_CREATE)
  async create(
    @Body(new ZodValidationPipe(CreateTenantRequestSchema)) body: CreateTenantRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
    @Req() req: Request,
  ): Promise<CreateTenantResponse> {
    return this.svc.create({
      ...body,
      actorUserId: user.userId,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
  }

  // Ops-on-behalf resend. Same permission (tenant.create) — the
  // tenant_admin in the target hospital can't trigger this because
  // their session has the wrong tenantId; this endpoint takes the
  // tenantId from the URL, not the actor.
  @Post(':tenantId/users/:userId/resend-invite')
  @HttpCode(200)
  @RequirePermission(Permissions.TENANT_CREATE)
  async resendPrimaryInvite(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @CurrentUser() user: Express.AuthenticatedUser,
    @Req() req: Request,
  ): Promise<ResendPrimaryInviteResponse> {
    return this.svc.resendPrimaryInvite({
      tenantId,
      targetUserId: userId,
      actorUserId: user.userId,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
  }
}
