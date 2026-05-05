import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { type HprAdapter, HPR_ADAPTER } from './hpr-adapter.interface';
import { HprRealAdapter } from './hpr-real.adapter';
import { HprStubAdapter } from './hpr-stub.adapter';
import { type AppConfig } from '../../config/configuration';

const adapterProvider: Provider = {
  provide: HPR_ADAPTER,
  inject: [ConfigService, HprStubAdapter, HprRealAdapter],
  useFactory: (
    config: ConfigService<AppConfig, true>,
    stub: HprStubAdapter,
    real: HprRealAdapter,
  ): HprAdapter => {
    const mode = config.get('HPR_MODE', { infer: true });
    return mode === 'real' ? real : stub;
  },
};

@Global()
@Module({
  providers: [HprStubAdapter, HprRealAdapter, adapterProvider],
  exports: [HPR_ADAPTER, HprStubAdapter, HprRealAdapter],
})
export class HprModule {}
