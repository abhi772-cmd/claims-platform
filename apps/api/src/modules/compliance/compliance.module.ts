import { Module } from '@nestjs/common';

import { ComplianceDashboardController } from './compliance-dashboard.controller';
import { ComplianceDashboardService } from './compliance-dashboard.service';

@Module({
  controllers: [ComplianceDashboardController],
  providers: [ComplianceDashboardService],
  exports: [ComplianceDashboardService],
})
export class ComplianceModule {}

export { ComplianceDashboardService } from './compliance-dashboard.service';
