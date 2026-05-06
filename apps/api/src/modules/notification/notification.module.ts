import { Global, Module } from '@nestjs/common';

import { EmailAdapter } from './email.adapter';
import { NotificationRetryWorker } from './notification-retry.worker';
import { NotificationService } from './notification.service';
import { SmsAdapter } from './sms.adapter';
import { TenantCommsConfigController } from './tenant-comms-config.controller';
import { TenantCommsConfigService } from './tenant-comms-config.service';

@Global()
@Module({
  controllers: [TenantCommsConfigController],
  providers: [
    TenantCommsConfigService,
    EmailAdapter,
    SmsAdapter,
    NotificationService,
    NotificationRetryWorker,
  ],
  exports: [NotificationService, NotificationRetryWorker, TenantCommsConfigService],
})
export class NotificationModule {}
