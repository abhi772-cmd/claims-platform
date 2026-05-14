// REST surface for `insuranceplan/request` lookups.
//
// Two URL shapes:
//   POST /cases/:caseId/claims/:claimId/insurance-plan/lookup
//     Lookup tied to an in-flight claim row. Stamps
//     claim.insuranceCorrelationId so every chained NHCX call inherits
//     the correlation id.
//   POST /insurance-plan/lookup
//     Freestanding lookup (no claim yet). Useful for pre-admission
//     policy verification at OPD; nothing gets stamped but the lookup
//     still flows through the audit ledger.

import {
  type InsurancePlanLookup,
  type InsurancePlanRequest,
  InsurancePlanRequestSchema,
  type InsurancePlanRequestResponse,
  Permissions,
} from '@claims/contracts';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { InsurancePlanService } from './insurance-plan.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CaseService } from '../case';

@ApiTags('insurance-plan')
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class InsurancePlanController {
  constructor(
    private readonly insurancePlan: InsurancePlanService,
    private readonly cases: CaseService,
  ) {}

  @Post('cases/:caseId/claims/:claimId/insurance-plan/lookup')
  @HttpCode(200)
  @RequirePermission(Permissions.CASE_CREATE)
  async lookupForClaim(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body(new ZodValidationPipe(InsurancePlanRequestSchema)) body: InsurancePlanRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<InsurancePlanRequestResponse> {
    const detail = await this.cases.getById(user.tenantId, caseId);
    const owns = detail.claims.some((c) => c.id === claimId);
    if (!owns) throw new ValidationFailedError({ claimId: ['Claim not on this case.'] });
    return this.insurancePlan.request({
      tenantId: user.tenantId,
      claimId,
      payerCode: body.payerCode,
      policyNumber: body.policyNumber,
      providerId: body.providerId,
      ...(body.payerDisplayName !== undefined
        ? { payerDisplayName: body.payerDisplayName }
        : {}),
      actorUserId: user.userId,
    });
  }

  @Post('insurance-plan/lookup')
  @HttpCode(200)
  @RequirePermission(Permissions.CASE_CREATE)
  async lookup(
    @Body(new ZodValidationPipe(InsurancePlanRequestSchema)) body: InsurancePlanRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<InsurancePlanRequestResponse> {
    return this.insurancePlan.request({
      tenantId: user.tenantId,
      payerCode: body.payerCode,
      policyNumber: body.policyNumber,
      providerId: body.providerId,
      ...(body.payerDisplayName !== undefined
        ? { payerDisplayName: body.payerDisplayName }
        : {}),
      actorUserId: user.userId,
    });
  }

  // --- Read endpoints --------------------------------------------
  // Latest plan lookup for a given claim. Returns 404 when no
  // lookup has been triggered for the claim yet (vs 200 with a
  // pending body) — the UI distinguishes "never asked" from
  // "asked and waiting on the payer". Operators read this to see
  // plan name / sum-insured before opening a preauth.
  @Get('cases/:caseId/claims/:claimId/insurance-plan')
  @RequirePermission(Permissions.CASE_VIEW)
  async getForClaim(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<InsurancePlanLookup> {
    const detail = await this.cases.getById(user.tenantId, caseId);
    const owns = detail.claims.some((c) => c.id === claimId);
    if (!owns) throw new ValidationFailedError({ claimId: ['Claim not on this case.'] });
    const row = await this.insurancePlan.findLatestForClaim(user.tenantId, claimId);
    if (!row) {
      throw new NotFoundException({
        message: 'No insurance plan lookup has been triggered for this claim yet.',
      });
    }
    return row;
  }

  // Direct correlation-id read for the freestanding lookup case
  // (pre-admission OPD flow). Returns the same shape as the
  // claim-bound endpoint.
  @Get('insurance-plan/lookups/:correlationId')
  @RequirePermission(Permissions.CASE_VIEW)
  async getByCorrelationId(
    @Param('correlationId') correlationId: string,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<InsurancePlanLookup> {
    const row = await this.insurancePlan.findByCorrelationId(user.tenantId, correlationId);
    if (!row) {
      throw new NotFoundException({
        message: `No insurance plan lookup with correlation id ${correlationId}.`,
      });
    }
    return row;
  }
}
