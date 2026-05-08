import { Global, Module } from '@nestjs/common';

import { AuditRetentionSweeperService } from './audit-retention-sweeper.service';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService, AuditRetentionSweeperService],
  exports: [AuditService, AuditRetentionSweeperService],
})
export class AuditModule {}
