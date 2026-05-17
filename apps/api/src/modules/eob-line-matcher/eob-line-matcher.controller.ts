// EOB-line matcher (Phase 1) — read endpoint.
//
//   GET /cases/:caseId/claims/:claimId/eob-line-matches
//
// Gated on claim.draft (same as bill-line-item read/save) since
// anyone who can draft a claim has the right to see the matcher's
// suggestion overlay. Phase 2 mutation endpoints (confirm /
// reject a suggested match) will likely require a stronger
// settlement-side permission.

import {
  type EobLineMatchesResponse,
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

import { EobLineMatcherService } from './eob-line-matcher.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { RolesGuard } from '../../common/guards/roles.guard';
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
