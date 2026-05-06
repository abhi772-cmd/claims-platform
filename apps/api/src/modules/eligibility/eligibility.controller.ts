import {
  type EligibilityRequest,
  EligibilityRequestSchema,
  type EligibilityResponse,
  type IntegrationMessageListResponse,
  Permissions,
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

import { EligibilityService } from './eligibility.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CaseService } from '../case';
import { IntegrationMessageService } from '../integration';

@ApiTags('eligibility')
@Controller('cases/:caseId/claims/:claimId')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EligibilityController {
  constructor(
    private readonly eligibility: EligibilityService,
    private readonly cases: CaseService,
    private readonly integration: IntegrationMessageService,
  ) {}

  @Post('eligibility')
  @HttpCode(200)
  @RequirePermission(Permissions.CASE_CREATE)
  async run(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body(new ZodValidationPipe(EligibilityRequestSchema)) body: EligibilityRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
    @Req() req: Request,
  ): Promise<EligibilityResponse> {
    // Verify the claim belongs to the case + tenant. CaseService already
    // does a tenant lookup; RLS catches cross-tenant separately.
    const detail = await this.cases.getById(user.tenantId, caseId);
    const owns = detail.claims.some((c) => c.id === claimId);
    if (!owns) throw new ValidationFailedError({ claimId: ['Claim not on this case.'] });
    return this.eligibility.run({
      tenantId: user.tenantId,
      caseId,
      claimId,
      actorUserId: user.userId,
      ...(body.policyNumber !== undefined ? { policyNumber: body.policyNumber } : {}),
      ...(body.payerCode !== undefined ? { payerCode: body.payerCode } : {}),
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
  }

  @Get('integration-messages')
  @RequirePermission(Permissions.CASE_VIEW)
  async listMessages(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<IntegrationMessageListResponse> {
    const detail = await this.cases.getById(user.tenantId, caseId);
    const owns = detail.claims.some((c) => c.id === claimId);
    if (!owns) throw new ValidationFailedError({ claimId: ['Claim not on this case.'] });
    const messages = await this.integration.listForClaim(user.tenantId, claimId);
    return { messages };
  }
}
