// T2-8 — preauth enhancement endpoints.
//
//   POST /cases/:caseId/claims/:claimId/enhancement/start
//   POST /cases/:caseId/claims/:claimId/enhancement/submit
//
// Permission: reuses `preauth.submit` — operators who can drive a
// preauth submission are the same operator class who can drive an
// enhancement (which is a preauth follow-up at the wire level).

import {
  type EnhancementResponse,
  type EnhancementStartRequest,
  EnhancementStartRequestSchema,
  type EnhancementSubmitRequest,
  EnhancementSubmitRequestSchema,
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

import { EnhancementService } from './enhancement.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CaseService } from '../case';

@ApiTags('enhancement')
@Controller('cases/:caseId/claims/:claimId/enhancement')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EnhancementController {
  constructor(
    private readonly enhancement: EnhancementService,
    private readonly cases: CaseService,
  ) {}

  @Post('start')
  @HttpCode(200)
  @RequirePermission(Permissions.PREAUTH_SUBMIT)
  async start(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body(new ZodValidationPipe(EnhancementStartRequestSchema)) body: EnhancementStartRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<EnhancementResponse> {
    void body;
    await this.assertOwns(user.tenantId, caseId, claimId);
    return this.enhancement.start({
      tenantId: user.tenantId,
      claimId,
      actorUserId: user.userId,
    });
  }

  @Post('submit')
  @HttpCode(200)
  @RequirePermission(Permissions.PREAUTH_SUBMIT)
  async submit(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body(new ZodValidationPipe(EnhancementSubmitRequestSchema))
    body: EnhancementSubmitRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<EnhancementResponse> {
    await this.assertOwns(user.tenantId, caseId, claimId);
    return this.enhancement.submit({
      tenantId: user.tenantId,
      claimId,
      actorUserId: user.userId,
      revisedAmount: body.revisedAmount,
      reason: body.reason,
    });
  }

  private async assertOwns(tenantId: string, caseId: string, claimId: string): Promise<void> {
    const detail = await this.cases.getById(tenantId, caseId);
    const owns = detail.claims.some((c) => c.id === claimId);
    if (!owns) throw new ValidationFailedError({ claimId: ['Claim not on this case.'] });
  }
}
