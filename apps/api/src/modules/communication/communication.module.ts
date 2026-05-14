import { Module } from '@nestjs/common';

import { CommunicationController } from './communication.controller';
import { CommunicationService } from './communication.service';
import { CaseModule } from '../case';
import { IntegrationModule } from '../integration';

// Stage 5 — hospital-initiated communication/request.
// NhcxModule + IntegrationModule are @Global, but we import them
// explicitly for clarity. CaseModule provides CaseService for the
// claim-ownership guard in the controller.
@Module({
  imports: [CaseModule, IntegrationModule],
  controllers: [CommunicationController],
  providers: [CommunicationService],
  exports: [CommunicationService],
})
export class CommunicationModule {}
