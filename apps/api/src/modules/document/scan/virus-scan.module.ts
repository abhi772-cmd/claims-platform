import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DisabledScanAdapter } from './disabled-scan.adapter';
import { StubScanAdapter } from './stub-scan.adapter';
import {
  VIRUS_SCAN_ADAPTER,
  type VirusScanAdapter,
} from './virus-scan-adapter.interface';
import { type AppConfig } from '../../../config/configuration';

const adapterProvider: Provider = {
  provide: VIRUS_SCAN_ADAPTER,
  inject: [ConfigService, DisabledScanAdapter, StubScanAdapter],
  useFactory: (
    config: ConfigService<AppConfig, true>,
    disabled: DisabledScanAdapter,
    stub: StubScanAdapter,
  ): VirusScanAdapter => {
    const mode = config.get('VIRUS_SCAN_MODE', { infer: true });
    if (mode === 'stub') return stub;
    if (mode === 'real') {
      // Sprint 5 will inject the ClamAvScanAdapter here. Until then,
      // 'real' is documented but not implemented — fall through to the
      // disabled path rather than failing boot, since several deploy
      // tiers (staging) want the env var ready before the scanner is.
      return disabled;
    }
    return disabled;
  },
};

@Global()
@Module({
  providers: [DisabledScanAdapter, StubScanAdapter, adapterProvider],
  exports: [VIRUS_SCAN_ADAPTER, DisabledScanAdapter, StubScanAdapter],
})
export class VirusScanModule {}
