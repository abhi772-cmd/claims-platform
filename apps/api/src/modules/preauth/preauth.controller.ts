import {
  Permissions,
  type PreauthCancelRequest,
  PreauthCancelRequestSchema,
  type PreauthCancelResponse,
  type PreauthDecisionRequest,
  PreauthDecisionRequestSchema,
  type PreauthDecisionResponse,
  type PreauthDraftRequest,
  PreauthDraftRequestSchema,
  type PreauthDraftResponse,
  type PreauthQueryResponseRequest,
  PreauthQueryResponseRequestSchema,
  type PreauthResubmitRequest,
  PreauthResubmitRequestSchema,
  type PreauthResubmitResponse,
  type PreauthSubmitRequest,
  PreauthSubmitRequestSchema,
  type PreauthSubmitResponse,
} from '@claims/contracts';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Request } from 'express';

import { PreauthService } from './preauth.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CaseService } from '../case';

@ApiTags('preauth')
@Controller('cases/:caseId/claims/:claimId/preauth')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PreauthController {
  constructor(
    private readonly preauth: PreauthService,
    private readonly cases: CaseService,
  ) {}

  @Get('draft')
  @RequirePermission(Permissions.PREAUTH_DRAFT)
  async getDraft(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<PreauthDraftResponse | { draft: null }> {
    await this.assertOwns(user.tenantId, caseId, claimId);
    const draft = await this.preauth.getDraft(user.tenantId, claimId);
    return draft ?? { draft: null };
  }

  @Put('draft')
  @HttpCode(200)
  @RequirePermission(Permissions.PREAUTH_DRAFT)
  async saveDraft(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body(new ZodValidationPipe(PreauthDraftRequestSchema)) body: PreauthDraftRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<PreauthDraftResponse> {
    await this.assertOwns(user.tenantId, caseId, claimId);
    return this.preauth.saveDraft({
      tenantId: user.tenantId,
      claimId,
      actorUserId: user.userId,
      draft: body,
    });
  }

  @Post('submit')
  @HttpCode(200)
  @RequirePermission(Permissions.PREAUTH_SUBMIT)
  async submit(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body(new ZodValidationPipe(PreauthSubmitRequestSchema)) body: PreauthSubmitRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
    @Req() req: Request,
  ): Promise<PreauthSubmitResponse> {
    void body;
    await this.assertOwns(user.tenantId, caseId, claimId);
    const out = await this.preauth.submit({
      tenantId: user.tenantId,
      claimId,
      actorUserId: user.userId,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    return {
      status: out.status,
      payerRefNum: out.payerRefNum,
      correlationId: out.correlationId,
    };
  }

  // Admin escape hatch — gated by case.assign so only admins can move
  // a claim to APPROVED / REJECTED / PARTIALLY_APPROVED / QUERY_RAISED
  // out-of-band. Real production decisions arrive via the rail-adapter
  // callback path (Slice P).
  // Slice BH — operator-driven preauth cancel via outbound NHCX
  // `task/submit`. PMJAY-only in v1; the service guards on
  // tenant.pmjayMode === 'on'. The state machine permits cancel
  // from any submitted-but-not-decisioned status (PREAUTH_QUEUED,
  // PREAUTH_SUBMITTED, PREAUTH_QUERY_RAISED, PREAUTH_QUERY_RESPONDED).
  @Post('cancel')
  @HttpCode(200)
  @RequirePermission(Permissions.PREAUTH_CANCEL)
  async cancel(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body(new ZodValidationPipe(PreauthCancelRequestSchema)) body: PreauthCancelRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<PreauthCancelResponse> {
    await this.assertOwns(user.tenantId, caseId, claimId);
    return this.preauth.cancelPreauth({
      tenantId: user.tenantId,
      claimId,
      actorUserId: user.userId,
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
    });
  }

  @Post('decision')
  @HttpCode(200)
  @RequirePermission(Permissions.CASE_ASSIGN)
  async decision(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body(new ZodValidationPipe(PreauthDecisionRequestSchema)) body: PreauthDecisionRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<PreauthDecisionResponse> {
    await this.assertOwns(user.tenantId, caseId, claimId);
    return this.preauth.applyDecision({
      tenantId: user.tenantId,
      claimId,
      actorUserId: user.userId,
      kind: body.kind,
      ...(body.approvedAmount !== undefined ? { approvedAmount: body.approvedAmount } : {}),
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      ...(body.queryText !== undefined ? { queryText: body.queryText } : {}),
    });
  }

  @Post('queries/:queryId/respond')
  @HttpCode(200)
  @RequirePermission(Permissions.PREAUTH_RESPOND_QUERY)
  async respondToQuery(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Param('queryId', new ParseUUIDPipe()) queryId: string,
    @Body(new ZodValidationPipe(PreauthQueryResponseRequestSchema))
    body: PreauthQueryResponseRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<{ status: string }> {
    await this.assertOwns(user.tenantId, caseId, claimId);
    return this.preauth.respondToQuery({
      tenantId: user.tenantId,
      claimId,
      queryId,
      actorUserId: user.userId,
      responseText: body.responseText,
    });
  }

  // Slice BL — PMJAY tenants pull the preauth back to PREAUTH_DRAFTING
  // instead of responding via Communication. State-only flip; the
  // operator's next preauth submit hits the gateway. We reuse
  // PREAUTH_RESPOND_QUERY because both gestures resolve an
  // outstanding query — the user with permission to "respond to a
  // query" is also the user with permission to "re-submit on query".
  @Post('resubmit')
  @HttpCode(200)
  @RequirePermission(Permissions.PREAUTH_RESPOND_QUERY)
  async resubmitOnQuery(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body(new ZodValidationPipe(PreauthResubmitRequestSchema))
    body: PreauthResubmitRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<PreauthResubmitResponse> {
    await this.assertOwns(user.tenantId, caseId, claimId);
    return this.preauth.resubmitOnQuery({
      tenantId: user.tenantId,
      claimId,
      actorUserId: user.userId,
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
    });
  }

  private async assertOwns(tenantId: string, caseId: string, claimId: string): Promise<void> {
    const detail = await this.cases.getById(tenantId, caseId);
    const owns = detail.claims.some((c) => c.id === claimId);
    if (!owns) throw new ValidationFailedError({ claimId: ['Claim not on this case.'] });
  }
}
