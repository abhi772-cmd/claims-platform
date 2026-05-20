import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  BILL_OCR_ADAPTER,
  type BillOcrAdapter,
} from './bill-ocr-adapter.interface';
import { DisabledBillOcrAdapter } from './disabled-bill-ocr.adapter';
import { HttpBillOcrAdapter } from './http-bill-ocr.adapter';
import { StubBillOcrAdapter } from './stub-bill-ocr.adapter';
import { type AppConfig } from '../../config/configuration';

const adapterProvider: Provider = {
  provide: BILL_OCR_ADAPTER,
  inject: [ConfigService, DisabledBillOcrAdapter, StubBillOcrAdapter, HttpBillOcrAdapter],
  useFactory: (
    config: ConfigService<AppConfig, true>,
    disabled: DisabledBillOcrAdapter,
    stub: StubBillOcrAdapter,
    http: HttpBillOcrAdapter,
  ): BillOcrAdapter => {
    const mode = config.get('BILL_OCR_MODE', { infer: true });
    if (mode === 'stub') return stub;
    if (mode === 'real') return http;
    return disabled;
  },
};

@Module({
  providers: [DisabledBillOcrAdapter, StubBillOcrAdapter, HttpBillOcrAdapter, adapterProvider],
  exports: [BILL_OCR_ADAPTER],
})
export class BillOcrModule {}
