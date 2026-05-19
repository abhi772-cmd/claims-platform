import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AbhaCreationController } from './abha-creation.controller';
import {
  ABHA_CREATION_ADAPTER,
  type AbhaCreationAdapter,
} from './abha-creation-adapter.interface';
import { AbhaCreationService } from './abha-creation.service';
import { DisabledAbhaCreationAdapter } from './disabled-abha-creation.adapter';
import { HttpAbhaCreationAdapter } from './http-abha-creation.adapter';
import { StubAbhaCreationAdapter } from './stub-abha-creation.adapter';
import { type AppConfig } from '../../config/configuration';

const adapterProvider: Provider = {
  provide: ABHA_CREATION_ADAPTER,
  inject: [ConfigService, DisabledAbhaCreationAdapter, StubAbhaCreationAdapter, HttpAbhaCreationAdapter],
  useFactory: (
    config: ConfigService<AppConfig, true>,
    disabled: DisabledAbhaCreationAdapter,
    stub: StubAbhaCreationAdapter,
    http: HttpAbhaCreationAdapter,
  ): AbhaCreationAdapter => {
    const mode = config.get('ABHA_CREATION_MODE', { infer: true });
    if (mode === 'stub') return stub;
    if (mode === 'http') return http;
    return disabled;
  },
};

@Global()
@Module({
  controllers: [AbhaCreationController],
  providers: [
    AbhaCreationService,
    DisabledAbhaCreationAdapter,
    StubAbhaCreationAdapter,
    HttpAbhaCreationAdapter,
    adapterProvider,
  ],
  exports: [AbhaCreationService],
})
export class AbhaCreationModule {}
