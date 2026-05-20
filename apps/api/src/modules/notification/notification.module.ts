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
  exports: [
    NotificationService,
    NotificationRetryWorker,
    TenantCommsConfigService,
    // Slice CM — ConsentOtpService dispatches OTPs directly via the
    // SMS adapter (it bypasses the template/render layer because the
    // OTP body is a fixed format and templated renders would also pull
    // in NotificationOutbox bookkeeping that the OTP audit row already
    // covers).
    SmsAdapter,
  ],
})
export class NotificationModule {}
