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
// instantiates when needed. The cleanest pattern is below.
const s3Provider: Provider = {
  provide: S3StorageAdapter,
  inject: [ConfigService],
  useFactory: (config: ConfigService<AppConfig, true>): S3StorageAdapter | null => {
    const mode = config.get('STORAGE_MODE', { infer: true });
    return mode === 'real' ? new S3StorageAdapter(config) : (null as unknown as S3StorageAdapter);
  },
};

@Global()
@Module({
  providers: [StubStorageAdapter, s3Provider, adapterProvider],
  exports: [STORAGE_ADAPTER, StubStorageAdapter, S3StorageAdapter],
})
export class StorageModule {}
