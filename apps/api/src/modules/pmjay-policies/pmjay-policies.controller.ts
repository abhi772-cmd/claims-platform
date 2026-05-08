// Slice BJ — PMJAY beneficiary policies lookup endpoint.
//
//   POST /pmjay/policies/lookup
//   body:    { identifierType: 'abha' | 'mobile', identifier: string }
//   returns: { policies: [...], identifierType, identifier }
//
// Permission: reuse PREAUTH_DRAFT — every operator who can start
// a preauth needs to be able to look up the beneficiary's policy.
// Adding a dedicated permission is a future split if the UX
// separates the desk that does the lookup from the desk that
// drafts the preauth.

import {
  Permissions,
  type PmjayPolicyLookupRequest,
  PmjayPolicyLookupRequestSchema,
  type PmjayPolicyLookupResponse,
} from '@claims/contracts';
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { PmjayPoliciesService } from './pmjay-policies.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('pmjay')
@Controller('pmjay/policies')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PmjayPoliciesController {
  constructor(private readonly service: PmjayPoliciesService) {}

  @Post('lookup')
  @HttpCode(200)
  @RequirePermission(Permissions.PREAUTH_DRAFT)
  async lookup(
    @Body(new ZodValidationPipe(PmjayPolicyLookupRequestSchema))
    body: PmjayPolicyLookupRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<PmjayPolicyLookupResponse> {
    return this.service.lookup({
      tenantId: user.tenantId,
      identifierType: body.identifierType,
      identifier: body.identifier,
    });
  }
}
