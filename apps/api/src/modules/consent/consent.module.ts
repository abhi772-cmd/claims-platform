import { Global, Module } from '@nestjs/common';

import { ConsentController } from './consent.controller';
import { ConsentOtpController } from './consent-otp.controller';
import { ConsentOtpService } from './consent-otp.service';
import { ConsentService } from './consent.service';

// @Global so `requireConsent` can be injected from any service
// (PatientService.getDecrypted, EligibilityService, ClaimSubmitService)
// without each module wiring an explicit import.
@Global()
@Module({
  controllers: [ConsentController, ConsentOtpController],
  providers: [ConsentService, ConsentOtpService],
  exports: [ConsentService, ConsentOtpService],
})
export class ConsentModule {}

export { ConsentService } from './consent.service';
export { ConsentOtpService } from './consent-otp.service';
