// Stage 9 — NHCX status search controller.
//
// One read-only endpoint:
//   GET /admin/nhcx/status-search
//     ?correlationId=X
//     [&claimRefNum=Y]
//     [&preauthRefNum=Z]
//
// At least one filter is required. Validation happens via the Zod
// schema (NhcxStatusSearchQuerySchema) so 422 lands with the right
// ProblemDetails shape via the global filter.

import {
  type NhcxStatusSearchResponse,
  NhcxStatusSearchQuerySchema,
  Permissions,
} from '@claims/contracts';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { NhcxStatusSearchService } from './nhcx-status-search.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('nhcx-status-search')
@Controller('admin/nhcx')
@UseGuards(JwtAuthGuard, RolesGuard)
export class NhcxStatusSearchController {
  constructor(private readonly service: NhcxStatusSearchService) {}

  @Get('status-search')
  @RequirePermission(Permissions.NHCX_STATUS_SEARCH)
  async search(
    @Query('correlationId') correlationId: string | undefined,
    @Query('claimRefNum') claimRefNum: string | undefined,
    @Query('preauthRefNum') preauthRefNum: string | undefined,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<NhcxStatusSearchResponse> {
    const parsed = NhcxStatusSearchQuerySchema.safeParse({
      ...(correlationId ? { correlationId } : {}),
      ...(claimRefNum ? { claimRefNum } : {}),
      ...(preauthRefNum ? { preauthRefNum } : {}),
    });
    if (!parsed.success) {
      const issues: Record<string, string[]> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path.join('.') || '_';
        issues[key] = (issues[key] ?? []).concat(issue.message);
      }
      throw new ValidationFailedError(issues);
    }
    return this.service.search({
      tenantId: user.tenantId,
      ...(parsed.data.correlationId ? { correlationId: parsed.data.correlationId } : {}),
      ...(parsed.data.claimRefNum ? { claimRefNum: parsed.data.claimRefNum } : {}),
      ...(parsed.data.preauthRefNum ? { preauthRefNum: parsed.data.preauthRefNum } : {}),
    });
  }
}
