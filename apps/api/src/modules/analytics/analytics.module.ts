import { Module } from '@nestjs/common';

import { VarianceController } from './variance.controller';
import { VarianceService } from './variance.service';

// T3-1 — CFO analytics. Tenant-scoped read-only aggregations over
// existing Claim + Case rows; no new tables, no state mutations.
// PrismaService is provided globally so no import is needed here.
@Module({
  controllers: [VarianceController],
  providers: [VarianceService],
  exports: [VarianceService],
})
export class AnalyticsModule {}
