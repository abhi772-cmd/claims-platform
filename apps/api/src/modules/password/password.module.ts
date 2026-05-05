import { Module } from '@nestjs/common';

import { BreachList } from './breach-list';
import { PasswordPolicyService } from './password-policy.service';
import { PasswordService } from './password.service';

// PasswordService + PasswordPolicyService are exported so AuthModule
// (for the reset endpoints + change endpoint) and UserModule (for invite
// accept) can depend on them. AuditService and NotificationService come
// from their respective @Global modules.
@Module({
  providers: [BreachList, PasswordPolicyService, PasswordService],
  exports: [PasswordPolicyService, PasswordService],
})
export class PasswordModule {}
