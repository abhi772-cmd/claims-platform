import { Module } from '@nestjs/common';

import { DoctorTokenController } from './doctor-token.controller';
import { DoctorTokenService } from './doctor-token.service';

// HprModule is @Global so the doctor-token service can inject the
// HPR_ADAPTER token without an explicit import here.
@Module({
  controllers: [DoctorTokenController],
  providers: [DoctorTokenService],
  exports: [DoctorTokenService],
})
export class DoctorModule {}
