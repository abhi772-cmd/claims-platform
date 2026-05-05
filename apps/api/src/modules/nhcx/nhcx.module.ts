import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { NHCX_ADAPTER, type NhcxAdapter } from './nhcx-adapter.interface';
import { NhcxJweAdapter } from './nhcx-jwe.adapter';
import {
  EnvKeyResolver,
  NHCX_KEY_RESOLVER,
  NhcxKeyResolverProvider,
} from './nhcx-key-resolver';
import { NhcxStubAdapter } from './nhcx-stub.adapter';
import { type AppConfig } from '../../config/configuration';

// Bind NHCX_ADAPTER to the right implementation based on NHCX_MODE.
// Both classes are also providers in their own right so unit tests can
// inject either directly when needed (the S3 adapter spec uses a real S3
// client against MinIO, the stub spec doesn't need any of that).
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
  providers: [
    NhcxStubAdapter,
    NhcxJweAdapter,
    EnvKeyResolver,
    NhcxKeyResolverProvider,
    adapterProvider,
  ],
  exports: [
    NHCX_ADAPTER,
    NHCX_KEY_RESOLVER,
    NhcxStubAdapter,
    NhcxJweAdapter,
    EnvKeyResolver,
  ],
})
export class NhcxModule {}
