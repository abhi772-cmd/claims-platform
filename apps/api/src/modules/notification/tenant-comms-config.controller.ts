import {
  Permissions,
  type TenantCommsConfig,
  TenantCommsConfigSchema,
  type TenantCommsConfigSummary,
} from '@claims/contracts';
import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { TenantCommsConfigService } from './tenant-comms-config.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

// Per-tenant comms (SMTP + SMS) configuration. Tenant admins can read
// the redacted summary and PATCH overrides. Secrets (smtp.password,
// sms.apiKey) are write-only — the GET response replaces them with
// boolean flags.
@ApiTags('tenant-comms-config')
@Controller('tenant/comms-config')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TenantCommsConfigController {
  constructor(private readonly comms: TenantCommsConfigService) {}

  @Get()
  @RequirePermission(Permissions.TENANT_COMMS_CONFIG_UPDATE)
  async get(
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<TenantCommsConfigSummary> {
    return this.comms.getSummary(user.tenantId);
  }

  @Patch()
  @RequirePermission(Permissions.TENANT_COMMS_CONFIG_UPDATE)
  async patch(
    @Body(new ZodValidationPipe(TenantCommsConfigSchema)) body: TenantCommsConfig,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<TenantCommsConfigSummary> {
    return this.comms.update(user.tenantId, body);
  }
}
