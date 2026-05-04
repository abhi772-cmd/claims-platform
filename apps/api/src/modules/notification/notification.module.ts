import { Global, Module } from '@nestjs/common';

import { EmailAdapter } from './email.adapter';
import { NotificationService } from './notification.service';
import { SmsAdapter } from './sms.adapter';

@Global()
@Module({
  providers: [EmailAdapter, SmsAdapter, NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
