import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { NhcxParticipantController } from './nhcx-participant.controller';
import { NHCX_PARTICIPANT_CLIENT } from './nhcx-participant-client.interface';
import { NhcxParticipantService } from './nhcx-participant.service';
import { StubNhcxParticipantClient } from './stub-nhcx-participant.client';
import { type AppConfig } from '../../config/configuration';

// NHCX_PARTICIPANT_MODE picks the client. Stub is the only mode for
// slice ON-4; the real HTTP adapter lands when NHA sandbox creds are
// available. The provider factory leaves room for `real` without
// forcing the import of an unfinished adapter.
const clientProvider: Provider = {
  provide: NHCX_PARTICIPANT_CLIENT,
  inject: [ConfigService, StubNhcxParticipantClient],
  useFactory: (
    _config: ConfigService<AppConfig, true>,
    stub: StubNhcxParticipantClient,
  ) => stub,
};

@Module({
  controllers: [NhcxParticipantController],
  providers: [StubNhcxParticipantClient, clientProvider, NhcxParticipantService],
  exports: [NhcxParticipantService],
})
export class NhcxParticipantModule {}
