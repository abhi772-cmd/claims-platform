import { Global, Module } from '@nestjs/common';

import { IntegrationMessageService } from './integration-message.service';

// @Global so any rail adapter (eligibility, preauth, claim submit) can
// inject it without an explicit imports list. Following the same pattern
// as AuditModule + NotificationModule.
@Global()
@Module({
  providers: [IntegrationMessageService],
  exports: [IntegrationMessageService],
})
export class IntegrationModule {}
