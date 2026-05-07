import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  BIOMETRIC_AUTH_ADAPTER,
  type BiometricAuthAdapter,
} from './biometric-auth-adapter.interface';
import { DisabledBiometricAuthAdapter } from './disabled-biometric-auth.adapter';
import { HttpBiometricAuthAdapter } from './http-biometric-auth.adapter';
import { StubBiometricAuthAdapter } from './stub-biometric-auth.adapter';
import { type AppConfig } from '../../config/configuration';

const adapterProvider: Provider = {
  provide: BIOMETRIC_AUTH_ADAPTER,
  inject: [
    ConfigService,
    DisabledBiometricAuthAdapter,
    StubBiometricAuthAdapter,
    HttpBiometricAuthAdapter,
  ],
  useFactory: (
    config: ConfigService<AppConfig, true>,
    disabled: DisabledBiometricAuthAdapter,
    stub: StubBiometricAuthAdapter,
    http: HttpBiometricAuthAdapter,
  ): BiometricAuthAdapter => {
    const mode = config.get('BIOMETRIC_AUTH_MODE', { infer: true });
    if (mode === 'stub') return stub;
    if (mode === 'real') return http;
    return disabled;
  },
};

@Global()
@Module({
  providers: [
    DisabledBiometricAuthAdapter,
    StubBiometricAuthAdapter,
    HttpBiometricAuthAdapter,
    adapterProvider,
  ],
  exports: [
    BIOMETRIC_AUTH_ADAPTER,
    DisabledBiometricAuthAdapter,
    StubBiometricAuthAdapter,
    HttpBiometricAuthAdapter,
  ],
})
export class BiometricAuthModule {}
