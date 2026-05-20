// Slice CN — tenant ↔ payer empanelment endpoints.
//
//   GET   /tenant/payers            → empanelled payers (active only)
//   GET   /tenant/payers/all        → empanelled payers incl. retired
//   GET   /tenant/payers/available  → registry + per-tenant empanelled flag
//   POST  /tenant/payers            → empanel a registry payer
//   PATCH /tenant/payers/:payerId   → toggle active (retire / re-activate)
//
// Reads use PAYER_MASTER_VIEW (tenants can browse). Mutations use the
// new TENANT_PAYER_EMPANEL permission — distinct from PAYER_MASTER_EDIT
// (which edits the shared registry and is superadmin-only).

import {
  type AvailablePayerListResponse,
  type EmpanelledPayer,
  type EmpanelledPayerListResponse,
  type EmpanelPayerRequest,
  EmpanelPayerRequestSchema,
  Permissions,
  type SetEmpanelmentActiveRequest,
  SetEmpanelmentActiveRequestSchema,
} from '@claims/contracts';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { TenantPayerService } from './tenant-payer.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('tenant-payers')
@Controller('tenant/payers')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TenantPayerController {
  constructor(private readonly service: TenantPayerService) {}

  @Get()
  @RequirePermission(Permissions.PAYER_MASTER_VIEW)
  async listEmpanelled(
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<EmpanelledPayerListResponse> {
    const payers = await this.service.listEmpanelled(user.tenantId, true);
    return { payers };
  }

  @Get('all')
  @RequirePermission(Permissions.PAYER_MASTER_VIEW)
  async listAll(
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<EmpanelledPayerListResponse> {
    const payers = await this.service.listEmpanelled(user.tenantId, false);
    return { payers };
  }

  @Get('available')
  @RequirePermission(Permissions.PAYER_MASTER_VIEW)
  async listAvailable(
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<AvailablePayerListResponse> {
    const payers = await this.service.listAvailable(user.tenantId);
    return { payers };
  }

  @Post()
  @HttpCode(200)
  @RequirePermission(Permissions.TENANT_PAYER_EMPANEL)
  async empanel(
    @Body(new ZodValidationPipe(EmpanelPayerRequestSchema)) body: EmpanelPayerRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<EmpanelledPayer> {
    return this.service.empanel(user.tenantId, body.payerId);
  }

  @Patch(':payerId')
  @HttpCode(200)
  @RequirePermission(Permissions.TENANT_PAYER_EMPANEL)
  async setActive(
    @Param('payerId', new ParseUUIDPipe()) payerId: string,
    @Body(new ZodValidationPipe(SetEmpanelmentActiveRequestSchema))
    body: SetEmpanelmentActiveRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<EmpanelledPayer> {
    return this.service.setActive(user.tenantId, payerId, body.active);
  }
}
