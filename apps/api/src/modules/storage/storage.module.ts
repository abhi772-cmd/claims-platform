import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { S3StorageAdapter } from './s3-storage.adapter';
import {
  STORAGE_ADAPTER,
  type StorageAdapter,
} from './storage-adapter.interface';
import { StubStorageAdapter } from './stub-storage.adapter';
import { type AppConfig } from '../../config/configuration';

// STORAGE_MODE picks which adapter satisfies the STORAGE_ADAPTER token.
// Both classes are also providers so unit tests can inject either
// directly (the S3 adapter spec uses a real S3 client against MinIO,
// the stub spec doesn't need any of that).
const adapterProvider: Provider = {
  provide: STORAGE_ADAPTER,
  inject: [ConfigService, StubStorageAdapter, S3StorageAdapter],
  useFactory: (
    config: ConfigService<AppConfig, true>,
    stub: StubStorageAdapter,
    s3: S3StorageAdapter,
  ): StorageAdapter => {
    const mode = config.get('STORAGE_MODE', { infer: true });
    return mode === 'real' ? s3 : stub;
  },
};

// We provide both adapters unconditionally so the factory can pick
// between them. S3StorageAdapter's constructor reads OVH_S3_* but the
// config loader has already validated those when STORAGE_MODE=real, so
// the construction won't throw in stub mode either (it'll just never
// be exercised by the factory).
//
// Caveat: in stub mode, the OVH_S3_* envs are optional → S3 ctor would
// throw. We dodge this by ALSO making S3 a factory provider that only
// instantiates when needed. When stubbed, we hand back a fail-fast
// proxy rather than null — null was a NPE waiting to happen the first
// time a caller dereferenced an S3-typed dependency; throwing on
// access tells the operator exactly what they misconfigured.
const s3Provider: Provider = {
  provide: S3StorageAdapter,
  inject: [ConfigService],
  useFactory: (config: ConfigService<AppConfig, true>): S3StorageAdapter => {
    const mode = config.get('STORAGE_MODE', { infer: true });
    if (mode === 'real') return new S3StorageAdapter(config);
    return makeStubModeS3StorageAdapter();
  },
};

// Stand-in returned when STORAGE_MODE=stub. The adapter selection
// factory routes STORAGE_ADAPTER to StubStorageAdapter in stub mode,
// so this proxy is only ever reached if test/runtime code injects
// S3StorageAdapter *directly* — which is wrong in stub mode. Any
// property access throws with a message that names the misuse.
// Symbol access (toString, inspect, etc.) returns undefined so the
// proxy survives logging and Nest's internal introspection.
//
// Exported for the regression spec at storage.module.spec.ts.
export function makeStubModeS3StorageAdapter(): S3StorageAdapter {
  return new Proxy({} as S3StorageAdapter, {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined;
      throw new Error(
        `S3StorageAdapter accessed with STORAGE_MODE=stub (property "${String(prop)}"). ` +
          'Set STORAGE_MODE=real, or inject StubStorageAdapter / STORAGE_ADAPTER instead.',
      );
    },
  });
}

@Global()
@Module({
  providers: [StubStorageAdapter, s3Provider, adapterProvider],
  exports: [STORAGE_ADAPTER, StubStorageAdapter, S3StorageAdapter],
})
export class StorageModule {}
