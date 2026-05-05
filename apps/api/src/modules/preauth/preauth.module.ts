import { Module } from '@nestjs/common';

import { PreauthController } from './preauth.controller';
import { PreauthService } from './preauth.service';
import { CaseModule } from '../case';
import { ClaimModule } from '../claim';

// NhcxModule is @Global — no explicit import needed for the adapter.
@Module({
  imports: [ClaimModule, CaseModule],
  controllers: [PreauthController],
  providers: [PreauthService],
  exports: [PreauthService],
})
export class PreauthModule {}
