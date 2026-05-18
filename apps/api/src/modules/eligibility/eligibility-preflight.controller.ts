import {
  Permissions,
  type VerifyCoverageByIdentifiersRequest,
  VerifyCoverageByIdentifiersRequestSchema,
  type VerifyCoverageByIdentifiersResponse,
} from '@claims/contracts';
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { EligibilityService } from './eligibility.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

// Eligibility preflight — sits at the root /eligibility prefix
// (NOT under /cases/:caseId/claims/:claimId) because the operator
// hits it BEFORE the case exists. Same CASE_CREATE permission as
// the case-creation endpoint so it gates on the same role boundary.
//
// The service method does not write to the DB — it's a sandbox
// lookup that calls the NHCX adapter and returns the flat policy
// shape the new-case form needs. No audit trail until the operator
// commits the case (which then runs the regular eligibility flow
// against the now-existing claim).
@ApiTags('eligibility')
@Controller('eligibility')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EligibilityPreflightController {
  constructor(private readonly eligibility: EligibilityService) {}

  @Post('verify-by-identifiers')
  @HttpCode(200)
  @RequirePermission(Permissions.CASE_CREATE)
  async verifyByIdentifiers(
    @Body(new ZodValidationPipe(VerifyCoverageByIdentifiersRequestSchema))
    body: VerifyCoverageByIdentifiersRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<VerifyCoverageByIdentifiersResponse> {
    return this.eligibility.verifyByIdentifiers(user.tenantId, body);
  }
}
