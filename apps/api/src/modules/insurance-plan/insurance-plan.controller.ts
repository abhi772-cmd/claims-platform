import {
  type InsurancePlanResponse,
  Permissions,
} from '@claims/contracts';
import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { InsurancePlanService } from './insurance-plan.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CaseService } from '../case';

@ApiTags('insurance-plan')
@Controller('cases/:caseId/claims/:claimId/insurance-plan')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InsurancePlanController {
  constructor(
    private readonly insurancePlan: InsurancePlanService,
    private readonly cases: CaseService,
  ) {}

  @Get()
  @RequirePermission(Permissions.CASE_VIEW)
  async get(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<InsurancePlanResponse> {
    await this.assertOwns(user.tenantId, caseId, claimId);
    return this.insurancePlan.getForClaim(user.tenantId, caseId, claimId);
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
