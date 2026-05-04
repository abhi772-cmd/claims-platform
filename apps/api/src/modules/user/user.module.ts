import { Module } from '@nestjs/common';

import { InviteService } from './invite.service';
import { UserAdminController } from './user-admin.controller';
import { UserService } from './user.service';

// JwtAuthGuard / RolesGuard come from the global SecurityModule.
// AuditService + NotificationService come from their respective @Global modules.
@Module({
  controllers: [UserAdminController],
  providers: [UserService, InviteService],
  exports: [UserService, InviteService],
})
export class UserModule {}
