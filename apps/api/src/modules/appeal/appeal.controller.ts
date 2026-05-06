import {
  type AppealResponse,
  type AppealSummary,
  Permissions,
  type ResolveAppealRequest,
  ResolveAppealRequestSchema,
  type StartAppealRequest,
  StartAppealRequestSchema,
  type SubmitAppealRequest,
  SubmitAppealRequestSchema,
} from '@claims/contracts';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';

import { AppealService } from './appeal.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CaseService } from '../case';

@Controller('cases/:caseId/claims/:claimId/appeal')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AppealController {
  constructor(
    private readonly appeals: AppealService,
    private readonly cases: CaseService,
  ) {}

  @Get()
  @RequirePermission(Permissions.CASE_VIEW)
  async getOpen(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<{ appeal: AppealSummary | null }> {
    await this.assertOwns(user.tenantId, caseId, claimId);
    const appeal = await this.appeals.getOpenForClaim(user.tenantId, claimId);
    return { appeal };
  }

  @Post('start')
  @HttpCode(200)
  @RequirePermission(Permissions.SETTLEMENT_APPEAL)
  async start(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body(new ZodValidationPipe(StartAppealRequestSchema)) body: StartAppealRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<AppealResponse> {
    await this.assertOwns(user.tenantId, caseId, claimId);
    return this.appeals.start({
      tenantId: user.tenantId,
      claimId,
      actorUserId: user.userId,
      reason: body.reason,
    });
  }

  @Post('submit')
  @HttpCode(200)
  @RequirePermission(Permissions.SETTLEMENT_APPEAL)
  async submit(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body(new ZodValidationPipe(SubmitAppealRequestSchema)) body: SubmitAppealRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<AppealResponse> {
    await this.assertOwns(user.tenantId, caseId, claimId);
    return this.appeals.submit({
      tenantId: user.tenantId,
      claimId,
      actorUserId: user.userId,
      supportingDocumentIds: body.supportingDocumentIds,
    });
  }

  @Post('resolve')
  @HttpCode(200)
  @RequirePermission(Permissions.SETTLEMENT_APPEAL)
  async resolve(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body(new ZodValidationPipe(ResolveAppealRequestSchema)) body: ResolveAppealRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<AppealResponse> {
    await this.assertOwns(user.tenantId, caseId, claimId);
    return this.appeals.resolve({
      tenantId: user.tenantId,
      claimId,
      actorUserId: user.userId,
      kind: body.kind,
      ...(body.approvedAmount !== undefined ? { approvedAmount: body.approvedAmount } : {}),
      ...(body.note !== undefined ? { note: body.note } : {}),
    });
  }

  private async assertOwns(tenantId: string, caseId: string, claimId: string): Promise<void> {
    const detail = await this.cases.getById(tenantId, caseId);
    const owns = detail.claims.some((c) => c.id === claimId);
    if (!owns) throw new ValidationFailedError({ claimId: ['Claim not on this case.'] });
  }
}
