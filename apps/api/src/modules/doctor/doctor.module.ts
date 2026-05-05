import { Module } from '@nestjs/common';

import { DoctorTokenController } from './doctor-token.controller';
import { DoctorTokenService } from './doctor-token.service';
import { HprService } from './hpr.service';

@Module({
  controllers: [DoctorTokenController],
  providers: [HprService, DoctorTokenService],
  exports: [DoctorTokenService],
})
export class DoctorModule {}
