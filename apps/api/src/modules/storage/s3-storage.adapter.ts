import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
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

// Real S3 adapter. Uses AWS SDK v3 against any S3-compatible endpoint
// (OVH Object Storage, MinIO, AWS S3 itself). The presigned PUT URL
// embeds the request signature so the client can upload directly to
// object storage — no bytes flow through the API server.
//
// V1 does NOT enforce server-side encryption headers or VPC restrictions
// — those are deployment-time concerns. The bucket is presumed to have
// the right policies attached (private, server-side encryption on,
// lifecycle rules). The Sprint 3 hardening pass adds:
//   * sha256 checksum verification on finalize
//   * presigned headers-required map matching the bucket's enforced
//     SSE algorithm
//   * lifecycle for 'pending' documents that never finalize
@Injectable()
export class S3StorageAdapter implements StorageAdapter, OnModuleDestroy {
  private readonly log = new Logger(S3StorageAdapter.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: ConfigService<AppConfig, true>) {
    const endpoint = config.get('OVH_S3_ENDPOINT', { infer: true });
    const region = config.get('OVH_S3_REGION', { infer: true });
    const accessKey = config.get('OVH_S3_ACCESS_KEY', { infer: true });
    const secretKey = config.get('OVH_S3_SECRET_KEY', { infer: true });
    const bucket = config.get('OVH_S3_BUCKET', { infer: true });
    const forcePathStyle = config.get('S3_FORCE_PATH_STYLE', { infer: true });

    if (!endpoint || !region || !accessKey || !secretKey || !bucket) {
      // The config loader rejects this case at boot, so reaching here
      // means a misconfigured DI graph rather than an env issue.
      throw new Error('S3StorageAdapter constructed without complete OVH_S3_* config.');
    }

    this.bucket = bucket;
    this.client = new S3Client({
      endpoint,
      region,
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
      forcePathStyle,
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.client.destroy();
  }

  async presignUpload(input: PresignUploadInput): Promise<PresignedUpload> {
    const ttl = this.config.get('S3_PRESIGN_TTL_SECONDS', { infer: true });
    const maxBytes = this.config.get('S3_MAX_UPLOAD_BYTES', { infer: true });
    if (input.declaredSizeBytes > maxBytes) {
      throw new Error(`Declared size ${input.declaredSizeBytes} exceeds max ${maxBytes}.`);
    }

    // {tenantId}/{claimId}/{documentId}-{filename}. Keeps tenant
    // isolation visible in the S3 key prefix so bucket-policy rules can
    // pin per-tenant access if needed.
    const safeFilename = input.originalFilename.replace(/[^A-Za-z0-9._-]/g, '_');
    const storageKey = `${input.tenantId}/${input.claimId}/${input.documentId}-${safeFilename}`;

    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: storageKey,
      ContentType: input.contentType,
      ContentLength: input.declaredSizeBytes,
    });
    const uploadUrl = await getSignedUrl(this.client, cmd, { expiresIn: ttl });

    return {
      storageBucket: this.bucket,
      storageKey,
      uploadUrl,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      requiredHeaders: {
        'content-type': input.contentType,
        'content-length': String(input.declaredSizeBytes),
      },
    };
  }

  async finalize(input: FinalizeInput): Promise<FinalizeResult> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: input.storageBucket, Key: input.storageKey }),
      );
      // S3 returns the ETag wrapped in quotes; strip them so the value
      // matches what other clients expect (curl HEAD reports unquoted).
      const etag = (head.ETag ?? '').replace(/^"(.*)"$/, '$1');
      const actualSizeBytes = Number(head.ContentLength ?? 0);
      if (!etag) {
        throw new Error('S3 HEAD returned no ETag.');
      }
      return { etag, actualSizeBytes };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`S3 finalize failed key=${input.storageKey}: ${message}`);
      throw err;
    }
  }

  // Slice AS — pull the object's bytes back. Used by the ClamAV scan
  // path for presigned-PUT uploads where the bytes never crossed the
  // API server on the way in. The SDK gives us a Body that is a
  // Readable stream; we drain it into a single Buffer because clamd's
  // INSTREAM protocol wants the full payload up front anyway.
  async presignDownload(input: PresignDownloadInput): Promise<PresignedDownload> {
    const ttl = this.config.get('S3_PRESIGN_TTL_SECONDS', { infer: true });
    const cmd = new GetObjectCommand({
      Bucket: input.storageBucket,
      Key: input.storageKey,
      // When the operator picks "download as foo.pdf" we ask S3 to
      // override the bucket-level content-disposition for this signed
      // request only. SDK supports it via ResponseContentDisposition;
      // SigV4 binds it to the signature so a tampered URL won't work.
      ...(input.downloadFilename !== undefined
        ? {
            ResponseContentDisposition: `attachment; filename="${sanitiseFilename(input.downloadFilename)}"`,
          }
        : {}),
    });
    const url = await getSignedUrl(this.client, cmd, { expiresIn: ttl });
    return {
      url,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    };
  }

  async getObject(input: GetObjectInput): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: input.storageBucket, Key: input.storageKey }),
    );
    if (!res.Body) {
      throw new Error(`S3 GetObject returned no Body for key=${input.storageKey}`);
    }
    // The SDK's Body type is a union of node Readable / Blob / web
    // ReadableStream depending on runtime. In Node we always get
    // Readable — `transformToByteArray` handles the conversion
    // uniformly so we don't have to branch.
    const bytes = await res.Body.transformToByteArray();
    return Buffer.from(bytes);
  }
}

// Strips CR, LF, and the closing double-quote — anything else would
// break the quoted-string slot of the Content-Disposition header.
// Unicode passes through; S3 handles UTF-8 in the signed header.
function sanitiseFilename(name: string): string {
  return name.replace(/[\r\n"]/g, '_').slice(0, 200);
}
