// Phase 4 — POST /identity/discover. Single best-effort orchestrator
// that runs every supplied identifier across the rails the tenant
// can transact on and returns the union of matches plus per-attempt
// diagnostic.
//
// Permission: CASE_CREATE — same gate as every other pre-case
// discovery surface. No DB writes; pure orchestration on top of
// the existing services.

import {
  type IdentityDiscoverRequest,
  IdentityDiscoverRequestSchema,
  type IdentityDiscoverResponse,
  Permissions,
} from '@claims/contracts';
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { IdentityDiscoverService } from './identity-discover.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('identity')
@Controller('identity')
@UseGuards(JwtAuthGuard, RolesGuard)
export class IdentityDiscoverController {
  constructor(private readonly service: IdentityDiscoverService) {}

  @Post('discover')
  @HttpCode(200)
  @RequirePermission(Permissions.CASE_CREATE)
  async discover(
    @Body(new ZodValidationPipe(IdentityDiscoverRequestSchema))
    body: IdentityDiscoverRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<IdentityDiscoverResponse> {
    return this.service.discover({
      tenantId: user.tenantId,
      ...(body.mobile ? { mobile: body.mobile } : {}),
      ...(body.abhaId ? { abhaId: body.abhaId } : {}),
      ...(body.aadhaar ? { aadhaar: body.aadhaar } : {}),
      ...(body.policyNumber ? { policyNumber: body.policyNumber } : {}),
      ...(body.patientName ? { patientName: body.patientName } : {}),
      ...(body.hospitalMrn ? { hospitalMrn: body.hospitalMrn } : {}),
    });
  }
}
