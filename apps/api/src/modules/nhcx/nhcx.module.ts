import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { NHCX_ADAPTER, type NhcxAdapter } from './nhcx-adapter.interface';
import { NhcxJweAdapter } from './nhcx-jwe.adapter';
import { NhcxStubAdapter } from './nhcx-stub.adapter';
import { type AppConfig } from '../../config/configuration';

// Bind NHCX_ADAPTER to the right implementation based on NHCX_MODE.
// Both classes are also providers in their own right so unit tests can
// inject either directly when needed (see nhcx-jwe.spec.ts which talks
// to a local mock gateway).
const adapterProvider: Provider = {
  provide: NHCX_ADAPTER,
  inject: [ConfigService, NhcxStubAdapter, NhcxJweAdapter],
  useFactory: (
    config: ConfigService<AppConfig, true>,
    stub: NhcxStubAdapter,
    jwe: NhcxJweAdapter,
  ): NhcxAdapter => {
    const mode = config.get('NHCX_MODE', { infer: true });
    return mode === 'real' ? jwe : stub;
  },
};

@Global()
@Module({
  providers: [NhcxStubAdapter, NhcxJweAdapter, adapterProvider],
  exports: [NHCX_ADAPTER, NhcxStubAdapter, NhcxJweAdapter],
})
export class NhcxModule {}
