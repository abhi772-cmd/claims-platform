import {
  type NhcxParticipantConfig,
  type NhcxParticipantListResponse,
  type NhcxParticipantStatusResponse,
  Permissions,
  type RegisterNhcxParticipantRequest,
  RegisterNhcxParticipantRequestSchema,
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

import { NhcxParticipantService } from './nhcx-participant.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('admin-nhcx-participant')
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class NhcxParticipantController {
  constructor(private readonly svc: NhcxParticipantService) {}

  // Cross-tenant listing for the ops dashboard.
  @Get('admin/nhcx-participants')
  @RequirePermission(Permissions.NHCX_PARTICIPANT_MANAGE)
  async list(): Promise<NhcxParticipantListResponse> {
    return this.svc.list();
  }

  @Get('admin/tenants/:tenantId/nhcx/participant-status')
  @RequirePermission(Permissions.NHCX_PARTICIPANT_MANAGE)
  async status(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
  ): Promise<NhcxParticipantStatusResponse> {
    return this.svc.status(tenantId);
  }

  @Post('admin/tenants/:tenantId/nhcx/register-participant')
  @HttpCode(200)
  @RequirePermission(Permissions.NHCX_PARTICIPANT_MANAGE)
  async register(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body(new ZodValidationPipe(RegisterNhcxParticipantRequestSchema))
    body: RegisterNhcxParticipantRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
    @Req() req: Request,
  ): Promise<NhcxParticipantConfig> {
    return this.svc.register({
      tenantId,
      actorUserId: user.userId,
      ...body,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
  }
}
