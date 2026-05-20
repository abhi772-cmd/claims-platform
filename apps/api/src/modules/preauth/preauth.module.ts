import { Module } from '@nestjs/common';

import { PreauthController } from './preauth.controller';
import { PreauthService } from './preauth.service';
import { CaseModule } from '../case';
import { ClaimModule } from '../claim';
import { DocumentModule } from '../document';
import { MasterDataModule } from '../master-data';
import { TenantModule } from '../tenant/tenant.module';

// BiometricAuthModule + NhcxModule are @Global — no explicit import
// needed for their adapters / services. DocumentModule + MasterDataModule
// are imported for the T1.1 checklist enforcement gate.
@Module({
  imports: [ClaimModule, CaseModule, TenantModule, DocumentModule, MasterDataModule],
  controllers: [PreauthController],
  providers: [PreauthService],
  exports: [PreauthService],
})
export class PreauthModule {}
