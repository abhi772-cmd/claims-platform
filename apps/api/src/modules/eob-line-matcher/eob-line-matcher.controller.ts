// EOB-line matcher — read + Phase 2 confirm/reset endpoints.
//
//   GET    /cases/:caseId/claims/:claimId/eob-line-matches
//   POST   /cases/:caseId/claims/:claimId/eob-line-matches/confirm
//   DELETE /cases/:caseId/claims/:claimId/eob-line-matches/:deductionIndex
//
// All gated on claim.draft (same as bill-line-item endpoints).
// Reviewer-confirm + reset both audit-log under
// resourceType='eob_line_match' so the trail captures who picked
// what, useful for appeal-drafting forensics.

import {
  type ConfirmEobLineMatchRequest,
  ConfirmEobLineMatchRequestSchema,
  type EobLineMatchesResponse,
  Permissions,
} from '@claims/contracts';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Request } from 'express';

import { EobLineMatcherService } from './eob-line-matcher.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CaseService } from '../case';

@ApiTags('eob-line-matcher')
@Controller('cases/:caseId/claims/:claimId/eob-line-matches')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EobLineMatcherController {
  constructor(
    private readonly matcher: EobLineMatcherService,
    private readonly cases: CaseService,
  ) {}

  @Get()
  @RequirePermission(Permissions.CLAIM_DRAFT)
  async suggest(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<EobLineMatchesResponse> {
    await this.assertOwns(user.tenantId, caseId, claimId);
    return this.matcher.suggestForClaim(user.tenantId, claimId);
  }

  @Post('confirm')
  @HttpCode(200)
  @RequirePermission(Permissions.CLAIM_DRAFT)
  async confirm(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body(new ZodValidationPipe(ConfirmEobLineMatchRequestSchema))
    body: ConfirmEobLineMatchRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
    @Req() req: Request,
  ): Promise<EobLineMatchesResponse> {
    await this.assertOwns(user.tenantId, caseId, claimId);
    return this.matcher.confirm({
      tenantId: user.tenantId,
      claimId,
      actorUserId: user.userId,
      request: body,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
  }

  @Delete(':deductionIndex')
  @HttpCode(200)
  @RequirePermission(Permissions.CLAIM_DRAFT)
  async reset(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Param('deductionIndex', new ParseIntPipe()) deductionIndex: number,
    @CurrentUser() user: Express.AuthenticatedUser,
    @Req() req: Request,
  ): Promise<EobLineMatchesResponse> {
    await this.assertOwns(user.tenantId, caseId, claimId);
    if (deductionIndex < 0) {
      throw new ValidationFailedError({
        deductionIndex: ['Must be ≥ 0.'],
      });
    }
    return this.matcher.reset({
      tenantId: user.tenantId,
      claimId,
      actorUserId: user.userId,
      deductionIndex,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
  }

  private async assertOwns(
    tenantId: string,
    caseId: string,
    claimId: string,
  ): Promise<void> {
    const detail = await this.cases.getById(tenantId, caseId);
    const owns = detail.claims.some((c) => c.id === claimId);
    if (!owns) throw new ValidationFailedError({ claimId: ['Claim not on this case.'] });
  }
}
