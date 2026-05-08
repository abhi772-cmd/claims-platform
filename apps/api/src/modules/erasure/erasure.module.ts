import { Module } from '@nestjs/common';

import { ErasureRequestController } from './erasure-request.controller';
import { ErasureRequestService } from './erasure-request.service';

// AuditModule + PrismaService are global so we don't need explicit
// imports here.
@Module({
  controllers: [ErasureRequestController],
  providers: [ErasureRequestService],
  exports: [ErasureRequestService],
})
export class ErasureModule {}
