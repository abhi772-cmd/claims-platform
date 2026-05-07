import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  type FinalizeInput,
  type FinalizeResult,
  type GetObjectInput,
  type PresignDownloadInput,
  type PresignUploadInput,
  type PresignedDownload,
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

  // Slice AS — stub has no real bytes to fetch (the upload was a
  // synthetic stub://-URL that the client never actually PUT to). This
  // path only fires in production with STORAGE_MODE=real, so throwing
  // here flags a misconfig: someone has VIRUS_SCAN_MODE=real wired
  // alongside STORAGE_MODE=stub, which can't possibly scan anything.
  async getObject(input: GetObjectInput): Promise<Buffer> {
    throw new Error(
      `StubStorageAdapter.getObject is not implemented (key=${input.storageKey}). Set STORAGE_MODE=real to read object bytes.`,
    );
  }

  // Slice AZ — returns a `stub://` URL that nothing actually serves.
  // Tests use it to confirm wire-up; production with STORAGE_MODE=stub
  // is a misconfig and the URL would 404 if a browser hit it.
  async presignDownload(input: PresignDownloadInput): Promise<PresignedDownload> {
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    return {
      url: `stub://${input.storageBucket}/${input.storageKey}`,
      expiresAt,
    };
  }
}
