import { Global, Module } from '@nestjs/common';

import { EmailAdapter } from './email.adapter';
import { NotificationRetryWorker } from './notification-retry.worker';
import { NotificationService } from './notification.service';
import { SmsAdapter } from './sms.adapter';

@Global()
@Module({
  providers: [EmailAdapter, SmsAdapter, NotificationService, NotificationRetryWorker],
  exports: [NotificationService, NotificationRetryWorker],
})
export class NotificationModule {}
