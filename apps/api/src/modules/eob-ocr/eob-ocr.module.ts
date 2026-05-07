import { Global, Logger, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DisabledEobOcrAdapter } from './disabled-eob-ocr.adapter';
import {
  EOB_OCR_ADAPTER,
  type EobOcrAdapter,
} from './eob-ocr-adapter.interface';
import { StubEobOcrAdapter } from './stub-eob-ocr.adapter';
import { type AppConfig } from '../../config/configuration';

const adapterProvider: Provider = {
  provide: EOB_OCR_ADAPTER,
  inject: [ConfigService, DisabledEobOcrAdapter, StubEobOcrAdapter],
  useFactory: (
    config: ConfigService<AppConfig, true>,
    disabled: DisabledEobOcrAdapter,
    stub: StubEobOcrAdapter,
  ): EobOcrAdapter => {
    const mode = config.get('EOB_OCR_MODE', { infer: true });
    if (mode === 'stub') return stub;
    if (mode === 'real') {
      // The OSS pipeline (PaddleOCR / Surya + Qwen2-VL / GOT-OCR2.0)
      // lands in a follow-up slice. Until then, 'real' is documented
      // but unimplemented — fall back to disabled and warn so a deploy
      // tier that flips the env early doesn't crash the boot.
      new Logger('EobOcrModule').warn(
        'EOB_OCR_MODE=real is not yet implemented; falling back to disabled.',
      );
      return disabled;
    }
    return disabled;
  },
};

@Global()
@Module({
  providers: [DisabledEobOcrAdapter, StubEobOcrAdapter, adapterProvider],
  exports: [EOB_OCR_ADAPTER, DisabledEobOcrAdapter, StubEobOcrAdapter],
})
export class EobOcrModule {}
