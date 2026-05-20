import { Module } from '@nestjs/common';

import { PayerCommercialTermsController } from './payer-commercial-terms.controller';
import { PayerCommercialTermsService } from './payer-commercial-terms.service';

@Module({
  controllers: [PayerCommercialTermsController],
  providers: [PayerCommercialTermsService],
  exports: [PayerCommercialTermsService],
})
export class PayerCommercialTermsModule {}
