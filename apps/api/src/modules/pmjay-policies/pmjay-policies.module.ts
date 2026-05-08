import { Module } from '@nestjs/common';

import { PmjayPoliciesController } from './pmjay-policies.controller';
import { PmjayPoliciesService } from './pmjay-policies.service';
import { TenantModule } from '../tenant/tenant.module';

// NhcxModule is @Global — no explicit import needed for the adapter.
@Module({
  imports: [TenantModule],
  controllers: [PmjayPoliciesController],
  providers: [PmjayPoliciesService],
  exports: [PmjayPoliciesService],
})
export class PmjayPoliciesModule {}
