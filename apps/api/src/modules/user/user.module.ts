import { Module } from '@nestjs/common';

import { InviteService } from './invite.service';
import { UserAdminController } from './user-admin.controller';
import { UserService } from './user.service';
import { PasswordModule } from '../password';

// JwtAuthGuard / RolesGuard come from the global SecurityModule.
// AuditService + NotificationService come from their respective @Global modules.
// PasswordModule is imported because invite.accept enforces the full
// password policy (shape + breach + history) on first password set.
@Module({
  imports: [PasswordModule],
  controllers: [UserAdminController],
  providers: [UserService, InviteService],
  exports: [UserService, InviteService],
})
export class UserModule {}
