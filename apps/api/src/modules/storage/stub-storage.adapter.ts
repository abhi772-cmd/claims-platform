import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  type FinalizeInput,
  type FinalizeResult,
  type PresignUploadInput,
  type PresignedUpload,
  type StorageAdapter,
} from './storage-adapter.interface';
import { type AppConfig } from '../../config/configuration';

// Stub: synthesises a storage key, returns a fake "upload URL" the
// client never actually hits. finalize() is a no-op that fabricates an
// etag + echoes the declared size back. Same shape as the real S3
// adapter so consumers don't see the difference.
@Injectable()
export class StubStorageAdapter implements StorageAdapter {
  private readonly bucket = 'claims-stub';

  // ConfigService is unused here but the constructor stays so DI is
  // identical to S3StorageAdapter — easier to swap in tests.
  constructor(private readonly _config: ConfigService<AppConfig, true>) {
    void this._config;
  }

  async presignUpload(input: PresignUploadInput): Promise<PresignedUpload> {
    const storageKey = `${input.tenantId}/${input.claimId}/${input.documentId}-${input.originalFilename}`;
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    return {
      storageBucket: this.bucket,
      storageKey,
      // The 'stub://' scheme makes it obvious to anyone who logs the
      // URL that no real upload happened.
      uploadUrl: `stub://${this.bucket}/${storageKey}`,
      expiresAt,
      requiredHeaders: { 'content-type': input.contentType },
    };
  }

  async finalize(input: FinalizeInput): Promise<FinalizeResult> {
    return {
      etag: `stub-etag-${input.storageKey.slice(-8)}`,
      // Stub mode trusts the declared size — the upload didn't actually
      // happen. Real mode HEADs S3 and uses the observed size.
      actualSizeBytes: 0,
    };
  }
}
