import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { DataAccessLogService } from './data-access-log.service';
import { PiiAccessInterceptor } from './pii-access.interceptor';

// @Global so any controller can apply @LogsPiiAccess without
// importing the module. The interceptor is registered as
// APP_INTERCEPTOR so it runs on every handler; it no-ops when the
// metadata is absent.
@Global()
@Module({
  providers: [
    DataAccessLogService,
    { provide: APP_INTERCEPTOR, useClass: PiiAccessInterceptor },
  ],
  exports: [DataAccessLogService],
})
export class DataAccessModule {}

export { DataAccessLogService } from './data-access-log.service';
export { LogsPiiAccess } from './logs-pii-access.decorator';
