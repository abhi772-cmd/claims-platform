import { Module } from '@nestjs/common';

import { TenantAdminController } from './tenant-admin.controller';
import { TenantAdminService } from './tenant-admin.service';
import { TenantConsentController } from './tenant-consent.controller';
import { TenantService } from './tenant.service';
import { UserModule } from '../user/user.module';

@Module({
  imports: [UserModule],
  controllers: [TenantConsentController, TenantAdminController],
  providers: [TenantService, TenantAdminService],
  exports: [TenantService, TenantAdminService],
})
export class TenantModule {}
