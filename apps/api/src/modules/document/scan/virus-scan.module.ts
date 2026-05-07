import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ClamAvScanAdapter } from './clamav-scan.adapter';
import { DisabledScanAdapter } from './disabled-scan.adapter';
import { StubScanAdapter } from './stub-scan.adapter';
import {
  VIRUS_SCAN_ADAPTER,
  type VirusScanAdapter,
} from './virus-scan-adapter.interface';
import { type AppConfig } from '../../../config/configuration';

const adapterProvider: Provider = {
  provide: VIRUS_SCAN_ADAPTER,
  inject: [ConfigService, DisabledScanAdapter, StubScanAdapter, ClamAvScanAdapter],
  useFactory: (
    config: ConfigService<AppConfig, true>,
    disabled: DisabledScanAdapter,
    stub: StubScanAdapter,
    clamav: ClamAvScanAdapter,
  ): VirusScanAdapter => {
    const mode = config.get('VIRUS_SCAN_MODE', { infer: true });
    if (mode === 'stub') return stub;
    if (mode === 'real') return clamav;
    return disabled;
  },
};

@Global()
@Module({
  providers: [DisabledScanAdapter, StubScanAdapter, ClamAvScanAdapter, adapterProvider],
  exports: [VIRUS_SCAN_ADAPTER, DisabledScanAdapter, StubScanAdapter, ClamAvScanAdapter],
})
export class VirusScanModule {}
