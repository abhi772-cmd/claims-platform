import { type DocumentType } from '@claims/contracts';

import { CaseApi } from './api/case.api';

// Hard upper bound matches UploadInitRequestSchema's 50 MB cap on the
// API. We surface a friendlier error than waiting for the server.
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

// scanBufferBase64 on finalize caps at 5 MB raw — see
// UploadFinalizeRequestSchema. Files larger than that under
// STORAGE_MODE=stub skip the in-process scan; that's a dev-mode
// limitation, not a production one (real ClamAV streams from S3).
export const STUB_SCAN_LIMIT_BYTES = 5 * 1024 * 1024;

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Web Crypto SHA-256 of the file bytes, hex-encoded. Computed in the
// browser so the server can verify the upload landed intact (real-mode
// requirement at production hardening; optional in stub).
export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function bytesToBase64(bytes: Uint8Array): string {
  // Chunked to avoid call-stack overflow on large inputs.
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Full upload pipeline shared by the claim-phase document manager and
// the pre-auth checklist:
//   1. uploadInit → server allocates a 'pending' Document row + returns
//      a presigned PUT URL (or 'stub://…' under STORAGE_MODE=stub).
//   2. PUT bytes to that URL (skipped for stub URLs — the server
//      already has the metadata; bytes go back via scanBufferBase64).
//   3. finalize → server HEADs the object (real) or scans the base64
//      payload (stub); the row flips to 'completed'.
// Throws on oversize / network / server error — callers surface the
// error via the modal and re-list documents on success.
export async function uploadDocument(
  caseId: string,
  claimId: string,
  file: File,
  documentType: DocumentType,
): Promise<void> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`File is ${fmtBytes(file.size)} — the 50 MB upload limit applies.`);
  }
  const buffer = await file.arrayBuffer();
  const contentSha256 = await sha256Hex(buffer);

  const init = await CaseApi.uploadInit(caseId, claimId, {
    documentType,
    originalFilename: file.name,
    contentType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
  });

  const isStub = init.uploadUrl.startsWith('stub://');
  if (!isStub) {
    const res = await fetch(init.uploadUrl, {
      method: 'PUT',
      headers: init.requiredHeaders,
      body: file,
    });
    if (!res.ok) {
      throw new Error(`Upload PUT failed: ${res.status} ${res.statusText}`);
    }
  }

  const finalizeBody: { contentSha256: string; scanBufferBase64?: string } = { contentSha256 };
  if (isStub && file.size <= STUB_SCAN_LIMIT_BYTES) {
    finalizeBody.scanBufferBase64 = bytesToBase64(new Uint8Array(buffer));
  }

  await CaseApi.uploadFinalize(caseId, claimId, init.document.id, finalizeBody);
}
