import {
  type DischargeInitiateRequest,
  DischargeInitiateRequestSchema,
  type DischargeResponse,
  type DischargeSubmitRequest,
  DischargeSubmitRequestSchema,
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

import { DischargeService } from './discharge.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CaseService } from '../case';

@Controller('cases/:caseId/claims/:claimId/discharge')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DischargeController {
  constructor(
    private readonly discharge: DischargeService,
    private readonly cases: CaseService,
  ) {}

  @Post('initiate')
  @HttpCode(200)
  @RequirePermission(Permissions.CLAIM_DRAFT)
  async initiate(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body(new ZodValidationPipe(DischargeInitiateRequestSchema)) body: DischargeInitiateRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<DischargeResponse> {
    void body;
    await this.assertOwns(user.tenantId, caseId, claimId);
    return this.discharge.initiate({
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
    @Body(new ZodValidationPipe(DischargeSubmitRequestSchema)) body: DischargeSubmitRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<DischargeResponse> {
    void body;
    await this.assertOwns(user.tenantId, caseId, claimId);
    return this.discharge.submit({
      tenantId: user.tenantId,
      claimId,
      actorUserId: user.userId,
    });
  }

  private async assertOwns(tenantId: string, caseId: string, claimId: string): Promise<void> {
    const detail = await this.cases.getById(tenantId, caseId);
    const owns = detail.claims.some((c) => c.id === claimId);
    if (!owns) throw new ValidationFailedError({ claimId: ['Claim not on this case.'] });
  }
}
