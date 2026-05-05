import { Module } from '@nestjs/common';

import { CaseController } from './case.controller';
import { CaseService } from './case.service';
import { ClaimController } from './claim.controller';
import { ClaimModule } from '../claim';

// Depends on the claim engine (Slice I). AuditService is global.
@Module({
  imports: [ClaimModule],
  controllers: [CaseController, ClaimController],
  providers: [CaseService],
  exports: [CaseService],
})
export class CaseModule {}
