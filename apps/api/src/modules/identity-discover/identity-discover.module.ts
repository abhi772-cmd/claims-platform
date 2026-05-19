import { Module } from '@nestjs/common';

import { IdentityDiscoverController } from './identity-discover.controller';
import { IdentityDiscoverService } from './identity-discover.service';
import { EligibilityModule } from '../eligibility';
import { PmjayPoliciesModule } from '../pmjay-policies';
import { TenantModule } from '../tenant/tenant.module';

@Module({
  imports: [EligibilityModule, PmjayPoliciesModule, TenantModule],
  controllers: [IdentityDiscoverController],
  providers: [IdentityDiscoverService],
  exports: [IdentityDiscoverService],
})
export class IdentityDiscoverModule {}
