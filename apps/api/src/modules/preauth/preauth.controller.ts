import {
  Permissions,
  type PreauthDecisionRequest,
  PreauthDecisionRequestSchema,
  type PreauthDecisionResponse,
  type PreauthDraftRequest,
  PreauthDraftRequestSchema,
  type PreauthDraftResponse,
  type PreauthQueryResponseRequest,
  PreauthQueryResponseRequestSchema,
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
import { type Request } from 'express';

import { PreauthService } from './preauth.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CaseService } from '../case';

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

  private async assertOwns(tenantId: string, caseId: string, claimId: string): Promise<void> {
    const detail = await this.cases.getById(tenantId, caseId);
    const owns = detail.claims.some((c) => c.id === claimId);
    if (!owns) throw new ValidationFailedError({ claimId: ['Claim not on this case.'] });
  }
}
