import { Global, Module } from '@nestjs/common';

import { ConsentController } from './consent.controller';
import { ConsentService } from './consent.service';

// @Global so `requireConsent` can be injected from any service
// (PatientService.getDecrypted, EligibilityService, ClaimSubmitService)
// without each module wiring an explicit import.
@Global()
@Module({
  controllers: [ConsentController],
  providers: [ConsentService],
  exports: [ConsentService],
})
export class ConsentModule {}

export { ConsentService } from './consent.service';
