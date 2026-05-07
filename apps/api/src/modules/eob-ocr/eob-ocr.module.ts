import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DisabledEobOcrAdapter } from './disabled-eob-ocr.adapter';
import {
  EOB_OCR_ADAPTER,
  type EobOcrAdapter,
} from './eob-ocr-adapter.interface';
import { HttpEobOcrAdapter } from './http-eob-ocr.adapter';
import { StubEobOcrAdapter } from './stub-eob-ocr.adapter';
import { type AppConfig } from '../../config/configuration';

const adapterProvider: Provider = {
  provide: EOB_OCR_ADAPTER,
  inject: [ConfigService, DisabledEobOcrAdapter, StubEobOcrAdapter, HttpEobOcrAdapter],
  useFactory: (
    config: ConfigService<AppConfig, true>,
    disabled: DisabledEobOcrAdapter,
    stub: StubEobOcrAdapter,
    http: HttpEobOcrAdapter,
  ): EobOcrAdapter => {
    const mode = config.get('EOB_OCR_MODE', { infer: true });
    if (mode === 'stub') return stub;
    if (mode === 'real') return http;
    return disabled;
  },
};

@Global()
@Module({
  providers: [DisabledEobOcrAdapter, StubEobOcrAdapter, HttpEobOcrAdapter, adapterProvider],
  exports: [EOB_OCR_ADAPTER, DisabledEobOcrAdapter, StubEobOcrAdapter, HttpEobOcrAdapter],
})
export class EobOcrModule {}
