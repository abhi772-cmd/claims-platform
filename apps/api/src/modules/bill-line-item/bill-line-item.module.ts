import { Module } from '@nestjs/common';

import { BillLineItemController } from './bill-line-item.controller';
import { BillLineItemService } from './bill-line-item.service';
import { CaseModule } from '../case';

@Module({
  imports: [CaseModule],
  controllers: [BillLineItemController],
  providers: [BillLineItemService],
  exports: [BillLineItemService],
})
export class BillLineItemModule {}
