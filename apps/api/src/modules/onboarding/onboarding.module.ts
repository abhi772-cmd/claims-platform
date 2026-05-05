import { Module } from '@nestjs/common';

import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { ReadinessService } from './readiness.service';
import { TenantLifecycleService } from './tenant-lifecycle.service';

@Module({
  controllers: [OnboardingController],
  providers: [OnboardingService, ReadinessService, TenantLifecycleService],
  exports: [OnboardingService, ReadinessService, TenantLifecycleService],
})
export class OnboardingModule {}
