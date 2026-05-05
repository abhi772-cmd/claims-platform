import {
  type IpAllowlist,
  IpAllowlistSchema,
  Permissions,
} from '@claims/contracts';
import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { type Request } from 'express';

import { IpAllowlistService } from './ip-allowlist.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('tenant/security')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TenantSecurityController {
  constructor(private readonly ipAllowlist: IpAllowlistService) {}

  @Get('ip-allowlist')
  @RequirePermission(Permissions.TENANT_SECURITY_UPDATE)
  async list(@CurrentUser() user: Express.AuthenticatedUser): Promise<IpAllowlist> {
    const cidrs = await this.ipAllowlist.list(user.tenantId);
    return { cidrs };
  }

  @Put('ip-allowlist')
  @RequirePermission(Permissions.TENANT_SECURITY_UPDATE)
  async update(
    @Body(new ZodValidationPipe(IpAllowlistSchema)) body: IpAllowlist,
    @CurrentUser() user: Express.AuthenticatedUser,
    @Req() req: Request,
  ): Promise<IpAllowlist> {
    const cidrs = await this.ipAllowlist.update(
      user.tenantId,
      user.userId,
      body.cidrs,
      req.ip ?? null,
      req.get('user-agent') ?? null,
    );
    return { cidrs };
  }
}
