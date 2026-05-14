import { Module } from '@nestjs/common';

import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { ReadinessService } from './readiness.service';
import { TenantLifecycleService } from './tenant-lifecycle.service';
import { TenantProfileService } from './tenant-profile.service';

@Module({
  controllers: [OnboardingController],
  providers: [
    OnboardingService,
    ReadinessService,
    TenantLifecycleService,
    TenantProfileService,
  ],
  exports: [
    OnboardingService,
    ReadinessService,
    TenantLifecycleService,
    TenantProfileService,
  ],
})
export class OnboardingModule {}
