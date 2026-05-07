import { Global, Module } from '@nestjs/common';

import { EmailAdapter } from './email.adapter';
import { NotificationRetryWorker } from './notification-retry.worker';
import { NotificationService } from './notification.service';
import { SmsAdapter } from './sms.adapter';
import { TenantCommsConfigController } from './tenant-comms-config.controller';
import { TenantCommsConfigService } from './tenant-comms-config.service';
import { TextGuruSmsProvider } from './textguru-sms.provider';

@Global()
@Module({
  controllers: [TenantCommsConfigController],
  providers: [
    TenantCommsConfigService,
    EmailAdapter,
    TextGuruSmsProvider,
    SmsAdapter,
    NotificationService,
    NotificationRetryWorker,
  ],
  exports: [NotificationService, NotificationRetryWorker, TenantCommsConfigService],
})
export class NotificationModule {}
