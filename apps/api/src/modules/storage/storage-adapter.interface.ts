// StorageAdapter abstracts the binary store. Two implementations:
//   StubStorageAdapter — synthetic key + faux URL; no real upload.
//                        Used in tests + dev when STORAGE_MODE=stub.
//   S3StorageAdapter   — presigned PUT URL against an S3-compatible
//                        endpoint (OVH Object Storage by default).
//
// The flow is intentionally split into init + finalize:
//   1. init(): server allocates the storage key, signs the PUT URL,
//              records a Document row in 'pending' state.
//   2. client PUTs the bytes directly to the URL.
//   3. finalize(): server HEADs the object, captures the etag + actual
//                  size, flips the row to 'completed'.
// Splitting like this avoids streaming the bytes through the API server
// — important for slow Indian hospital uplinks, where 50 MiB final-bill
// PDFs would tie up Node workers.

export const STORAGE_ADAPTER = Symbol('STORAGE_ADAPTER');

export interface PresignedUpload {
  // Where the row's binary will live once uploaded.
  storageBucket: string;
  storageKey: string;
  // Pre-signed PUT URL the client should use to upload.
  uploadUrl: string;
  // When the URL stops working (ISO).
  expiresAt: string;
  // Headers the client MUST send with the PUT (Content-Type minimum).
  // Sending extra/missing headers will fail signature verification.
  requiredHeaders: Record<string, string>;
}

export interface PresignUploadInput {
  tenantId: string;
  claimId: string;
  documentId: string;
  contentType: string;
  declaredSizeBytes: number;
  originalFilename: string;
}

export interface FinalizeInput {
  storageBucket: string;
  storageKey: string;
}

export interface FinalizeResult {
  etag: string;
  // Actual size as observed via HEAD on the object. Diverges from
  // declaredSize if the client misreported or the upload was truncated.
  actualSizeBytes: number;
}

export interface StorageAdapter {
  // Returns the upload URL + the storage references the Document row
  // should record. Pure — no DB writes.
  presignUpload(input: PresignUploadInput): Promise<PresignedUpload>;

  // HEAD the uploaded object. Throws if the object doesn't exist (the
  // client never uploaded) or if some other error blocked the read.
  finalize(input: FinalizeInput): Promise<FinalizeResult>;
}
