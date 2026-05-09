// Slice CG — DPDP §6 hard-enforcement admin endpoint.
//
// Flips `tenant.requireConsent` per-tenant. Gated on
// `tenant.security.update` because flipping this is a security-
// posture change that affects every preauth/claim/discharge flow
// on the tenant. Operators run this AFTER the tenant's "unbound
// access in 24h" count on the BU dashboard reads zero —
// otherwise turning it on breaks every active flow.

import { Permissions } from '@claims/contracts';
import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { TenantService } from './tenant.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

const SetRequireConsentSchema = z.object({
  enabled: z.boolean(),
});

@ApiTags('admin-tenants')
@Controller('admin/tenants')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TenantConsentController {
  constructor(private readonly tenants: TenantService) {}

  @Post(':tenantId/require-consent')
  @HttpCode(200)
  @RequirePermission(Permissions.TENANT_SECURITY_UPDATE)
  async setRequireConsent(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body(new ZodValidationPipe(SetRequireConsentSchema))
    body: z.infer<typeof SetRequireConsentSchema>,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<{ id: string; requireConsent: boolean }> {
    // Belt-and-suspenders: the user's tenantId must match the
    // path tenantId. platform_admin can bypass when needed via
    // a separate cross-tenant flow (not exposed here).
    if (user.tenantId !== tenantId) {
      // Throwing a generic 403-equivalent via the validation
      // mechanism keeps the surface narrow.
      throw new Error('Forbidden: cross-tenant flag flip not permitted on this endpoint.');
    }
    const updated = await this.tenants.setRequireConsent({
      tenantId,
      enabled: body.enabled,
      actorUserId: user.userId,
    });
    return { id: updated.id, requireConsent: updated.requireConsent };
  }
}
