import { Module } from '@nestjs/common';

import { EnhancementController } from './enhancement.controller';
import { EnhancementService } from './enhancement.service';
import { CaseModule } from '../case';
import { ClaimModule } from '../claim';
import { NhcxModule } from '../nhcx';

@Module({
  imports: [ClaimModule, CaseModule, NhcxModule],
  controllers: [EnhancementController],
  providers: [EnhancementService],
  exports: [EnhancementService],
})
export class EnhancementModule {}
