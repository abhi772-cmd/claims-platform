import { Global, Module } from '@nestjs/common';

import { IntegrationMessageService } from './integration-message.service';
import { NhcxReplayWorker } from './nhcx-replay.worker';
import { NhcxStatusSearchController } from './nhcx-status-search.controller';
import { NhcxStatusSearchService } from './nhcx-status-search.service';

// @Global so any rail adapter (eligibility, preauth, claim submit) can
// inject it without an explicit imports list. Following the same pattern
// as AuditModule + NotificationModule.
//
// T1-5 — also hosts NhcxReplayWorker. Services that opt into the
// queue call `NhcxReplayWorker.registerHandler()` from their own
// OnApplicationBootstrap hook to add themselves to the dispatch
// table. Runtime registration (instead of DI multi-provider) keeps
// the wiring simple across module load order.
//
// Stage 9 — also hosts the ops-only status-search endpoint. The
// service is internal-use, so it's not exported globally; the
// controller is the only public surface.
@Global()
@Module({
  controllers: [NhcxStatusSearchController],
  providers: [IntegrationMessageService, NhcxReplayWorker, NhcxStatusSearchService],
  exports: [IntegrationMessageService, NhcxReplayWorker],
})
export class IntegrationModule {}
