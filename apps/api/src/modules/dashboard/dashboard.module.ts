import { Module } from '@nestjs/common';

import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

// PrismaModule + SecurityModule (JwtAuthGuard / RolesGuard) are
// both @Global; no imports needed here. computeSlaForClaim is a
// pure function so no injection.
@Module({
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
