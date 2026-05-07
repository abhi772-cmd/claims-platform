import {
  type ClaimDecisionRequest,
  ClaimDecisionRequestSchema,
  type ClaimDecisionResponse,
  type ClaimReprocessRequest,
  ClaimReprocessRequestSchema,
  type ClaimReprocessResponse,
  type ClaimSubmissionResponse,
  type ClaimSubmissionStartRequest,
  ClaimSubmissionStartRequestSchema,
  type ClaimSubmissionSubmitRequest,
  ClaimSubmissionSubmitRequestSchema,
  Permissions,
} from '@claims/contracts';
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

import { ClaimSubmitService } from './claim-submit.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CaseService } from '../case';

@ApiTags('claim-submission')
@Controller('cases/:caseId/claims/:claimId/claim-submission')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ClaimSubmitController {
  constructor(
    private readonly claimSubmit: ClaimSubmitService,
    private readonly cases: CaseService,
  ) {}

  @Post('start')
  @HttpCode(200)
  @RequirePermission(Permissions.CLAIM_DRAFT)
  async start(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body(new ZodValidationPipe(ClaimSubmissionStartRequestSchema))
    body: ClaimSubmissionStartRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<{ status: string }> {
    void body;
    await this.assertOwns(user.tenantId, caseId, claimId);
    return this.claimSubmit.start({
      tenantId: user.tenantId,
      claimId,
      actorUserId: user.userId,
    });
  }

  @Post('submit')
  @HttpCode(200)
  @RequirePermission(Permissions.CLAIM_SUBMIT)
  async submit(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body(new ZodValidationPipe(ClaimSubmissionSubmitRequestSchema))
    body: ClaimSubmissionSubmitRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<ClaimSubmissionResponse> {
    await this.assertOwns(user.tenantId, caseId, claimId);
    return this.claimSubmit.submit({
      tenantId: user.tenantId,
      claimId,
      actorUserId: user.userId,
      finalAmount: body.finalAmount,
    });
  }

  // Slice BI — PMJAY CRC reprocess via outbound `task/submit`.
  // PMJAY-only in v1; the service guards on tenant.pmjayMode === 'on'
  // and on reasonCode/status alignment (claimrejected requires
  // CLAIM_REJECTED; partialpayment requires SHORT_PAID).
  @Post('reprocess')
  @HttpCode(200)
  @RequirePermission(Permissions.CLAIM_REPROCESS)
  async reprocess(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body(new ZodValidationPipe(ClaimReprocessRequestSchema)) body: ClaimReprocessRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<ClaimReprocessResponse> {
    await this.assertOwns(user.tenantId, caseId, claimId);
    return this.claimSubmit.reprocessClaim({
      tenantId: user.tenantId,
      claimId,
      actorUserId: user.userId,
      reasonCode: body.reasonCode,
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
    });
  }

  // Admin escape hatch — gated by case.assign. Real production decisions
  // arrive via the rail-adapter callback path in Slice P.
  @Post('decision')
  @HttpCode(200)
  @RequirePermission(Permissions.CASE_ASSIGN)
  async decision(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body(new ZodValidationPipe(ClaimDecisionRequestSchema)) body: ClaimDecisionRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<ClaimDecisionResponse> {
    await this.assertOwns(user.tenantId, caseId, claimId);
    return this.claimSubmit.applyDecision({
      tenantId: user.tenantId,
      claimId,
      actorUserId: user.userId,
      kind: body.kind,
      ...(body.approvedAmount !== undefined ? { approvedAmount: body.approvedAmount } : {}),
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      ...(body.queryText !== undefined ? { queryText: body.queryText } : {}),
    });
  }

  private async assertOwns(tenantId: string, caseId: string, claimId: string): Promise<void> {
    const detail = await this.cases.getById(tenantId, caseId);
    const owns = detail.claims.some((c) => c.id === claimId);
    if (!owns) throw new ValidationFailedError({ claimId: ['Claim not on this case.'] });
  }
}
