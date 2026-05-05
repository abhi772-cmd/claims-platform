import { Global, Module } from '@nestjs/common';

import { PatientService } from './patient.service';

// @Global so CaseService (and future claim/preauth services that need
// decrypted patient PII for FHIR bundle building) can inject without
// importing PatientModule everywhere.
@Global()
@Module({
  providers: [PatientService],
  exports: [PatientService],
})
export class PatientModule {}
