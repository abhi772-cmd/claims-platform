import { Module } from '@nestjs/common';

import { ClaimReconstructionService } from './claim-reconstruction.service';
import { ClaimService } from './claim.service';

// Engine only in Slice I — no controllers, no HTTP surface. Slice J
// (Patient + Case CRUD) wires this through to the API.
@Module({
  providers: [ClaimService, ClaimReconstructionService],
  exports: [ClaimService, ClaimReconstructionService],
})
export class ClaimModule {}
