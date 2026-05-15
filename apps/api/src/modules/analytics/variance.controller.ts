import {
  Permissions,
  type VarianceAgingBucket,
  VarianceAgingBucketSchema,
  type VarianceByPayerResponse,
  type VarianceClaimsResponse,
  type VarianceSummaryResponse,
} from '@claims/contracts';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { VarianceService } from './variance.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

// T3-1 — CFO variance dashboard. Three read endpoints, all gated on
// analytics.view (the existing permission the CFO role carries):
//   GET /analytics/variance/summary       → KPI tiles + aging buckets
//   GET /analytics/variance/by-payer      → top-N payers by leakage
//   GET /analytics/variance/claims        → drill-down list
//
// Filters are kept query-string only; tiny enough to not deserve a
// Zod body schema. The bucket enum IS validated via the shared
// VarianceAgingBucketSchema so the controller doesn't accept
// arbitrary strings.

@ApiTags('analytics')
@Controller('analytics/variance')
@UseGuards(JwtAuthGuard, RolesGuard)
export class VarianceController {
  constructor(private readonly variance: VarianceService) {}

  @Get('summary')
  @RequirePermission(Permissions.ANALYTICS_VIEW)
  async summary(
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<VarianceSummaryResponse> {
    return this.variance.summary(user.tenantId);
  }

  @Get('by-payer')
  @RequirePermission(Permissions.ANALYTICS_VIEW)
  async byPayer(
    @Query('limit') limit: string | undefined,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<VarianceByPayerResponse> {
    const parsed = limit !== undefined && /^\d+$/.test(limit)
      ? Number.parseInt(limit, 10)
      : undefined;
    return this.variance.byPayer(user.tenantId, parsed);
  }

  @Get('claims')
  @RequirePermission(Permissions.ANALYTICS_VIEW)
  async claims(
    @Query('bucket') bucket: string | undefined,
    @Query('payerCode') payerCode: string | undefined,
    @Query('limit') limit: string | undefined,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<VarianceClaimsResponse> {
    let typedBucket: VarianceAgingBucket | undefined;
    if (bucket !== undefined && bucket.length > 0) {
      const parsed = VarianceAgingBucketSchema.safeParse(bucket);
      if (!parsed.success) {
        throw new ValidationFailedError({
          bucket: [`Unknown aging bucket "${bucket}". Allowed: d0_7, d8_14, d15_30, d31_plus.`],
        });
      }
      typedBucket = parsed.data;
    }
    const parsedLimit = limit !== undefined && /^\d+$/.test(limit)
      ? Number.parseInt(limit, 10)
      : undefined;
    return this.variance.claims(user.tenantId, {
      ...(typedBucket !== undefined ? { bucket: typedBucket } : {}),
      ...(payerCode !== undefined && payerCode.length > 0 ? { payerCode } : {}),
      ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
    });
  }
}
