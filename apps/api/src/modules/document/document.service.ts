import { randomUUID } from 'node:crypto';

import {
  type Document,
  type DocumentType,
  type DocumentUploadStatus,
  type EobExtractResponse,
} from '@claims/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { VIRUS_SCAN_ADAPTER, type VirusScanAdapter } from './scan';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { type AppConfig } from '../../config/configuration';
import {
  EOB_OCR_ADAPTER,
  type EobOcrAdapter,
  type ExtractInput,
} from '../eob-ocr';
import { STORAGE_ADAPTER, type StorageAdapter } from '../storage';

export interface UploadStubInput {
  tenantId: string;
  claimId: string;
  actorUserId: string;
  documentType: DocumentType;
  originalFilename: string;
  contentType: string;
  sizeBytes: number;
}

export interface UploadInitInput {
  tenantId: string;
  claimId: string;
  actorUserId: string;
  documentType: DocumentType;
  originalFilename: string;
  contentType: string;
  sizeBytes: number;
}

export interface UploadInitResult {
  document: Document;
  uploadUrl: string;
  expiresAt: string;
  requiredHeaders: Record<string, string>;
}

export interface FinalizeUploadInput {
  tenantId: string;
  claimId: string;
  documentId: string;
  contentSha256?: string;
  // Optional bytes for in-process scanning. Only used by the stub
  // scanner — the real ClamAV adapter streams from S3 by (bucket,key).
  scanBuffer?: Buffer;
}

export interface ExtractEobInput {
  tenantId: string;
  claimId: string;
  documentId: string;
  // Optional inline bytes. When set, the OCR adapter scans them
  // directly. When omitted, the adapter is expected to fetch from
  // (bucket, key) — works in real-mode storage; stub-storage throws
  // and surfaces as `failed` per the AS pattern.
  buffer?: Buffer;
}

@Injectable()
export class DocumentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    @Inject(VIRUS_SCAN_ADAPTER) private readonly scanner: VirusScanAdapter,
    @Inject(EOB_OCR_ADAPTER) private readonly eobOcr: EobOcrAdapter,
  ) {}

  // V1 stub flow: synthesise + create the row in 'completed' state in
  // a single tx. Behaviour preserved for the existing upload-stub
  // endpoint and tests that don't exercise the real S3 path.
  async uploadStub(input: UploadStubInput): Promise<Document> {
    const storageBucket = 'claims-stub';
    const storageKey = `${input.tenantId}/${input.claimId}/${randomUUID()}-${input.originalFilename}`;
    const row = await this.prisma.runInTenantContext(input.tenantId, 'tenant', (tx) =>
      tx.document.create({
        data: {
          tenantId: input.tenantId,
          claimId: input.claimId,
          documentType: input.documentType,
          storageBucket,
          storageKey,
          contentType: input.contentType,
          sizeBytes: input.sizeBytes,
          originalFilename: input.originalFilename,
          uploadedById: input.actorUserId,
          uploadStatus: 'completed',
          finalizedAt: new Date(),
        },
      }),
    );
    return toDocument(row);
  }

  // Init flow: server picks the storage key, signs the URL, creates a
  // 'pending' Document row. The client uploads to the URL directly,
  // then calls finalize() to flip the row to 'completed'.
  async initUpload(input: UploadInitInput): Promise<UploadInitResult> {
    const documentId = randomUUID();
    const presigned = await this.storage.presignUpload({
      tenantId: input.tenantId,
      claimId: input.claimId,
      documentId,
      contentType: input.contentType,
      declaredSizeBytes: input.sizeBytes,
      originalFilename: input.originalFilename,
    });

    const row = await this.prisma.runInTenantContext(input.tenantId, 'tenant', (tx) =>
      tx.document.create({
        data: {
          id: documentId,
          tenantId: input.tenantId,
          claimId: input.claimId,
          documentType: input.documentType,
          storageBucket: presigned.storageBucket,
          storageKey: presigned.storageKey,
          contentType: input.contentType,
          sizeBytes: input.sizeBytes,
          originalFilename: input.originalFilename,
          uploadedById: input.actorUserId,
          uploadStatus: 'pending',
        },
      }),
    );

    return {
      document: toDocument(row),
      uploadUrl: presigned.uploadUrl,
      expiresAt: presigned.expiresAt,
      requiredHeaders: presigned.requiredHeaders,
    };
  }

  async finalizeUpload(input: FinalizeUploadInput): Promise<Document> {
    const row = await this.prisma.runInTenantContext(input.tenantId, 'tenant', (tx) =>
      tx.document.findUnique({ where: { id: input.documentId } }),
    );
    if (!row || row.tenantId !== input.tenantId || row.claimId !== input.claimId) {
      throw new ValidationFailedError({ documentId: ['Document not found.'] });
    }
    if (row.uploadStatus === 'completed') {
      // Already finalized — idempotent return.
      return toDocument(row);
    }
    if (row.uploadStatus === 'failed') {
      throw new ValidationFailedError({
        documentId: ['Upload previously failed; re-init required.'],
      });
    }

    let etag: string;
    let actualSizeBytes: number;
    try {
      const head = await this.storage.finalize({
        storageBucket: row.storageBucket,
        storageKey: row.storageKey,
      });
      etag = head.etag;
      actualSizeBytes = head.actualSizeBytes;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failedRow = await this.prisma.runInTenantContext(
        input.tenantId,
        'tenant',
        (tx) =>
          tx.document.update({
            where: { id: input.documentId },
            data: {
              uploadStatus: 'failed',
              uploadError: message.slice(0, 500),
            },
          }),
      );
      void failedRow;
      throw new ValidationFailedError({
        documentId: [`Upload finalize failed: ${message}`],
      });
    }

    // For the stub adapter, actualSizeBytes is 0 (no real upload happened).
    // Trust the declared size in that case so the row keeps the value the
    // client passed at init time.
    const sizeToRecord = actualSizeBytes > 0 ? actualSizeBytes : row.sizeBytes;

    // Virus scan. The off-mode adapter returns 'skipped' immediately.
    // The stub-mode adapter detects EICAR in any provided buffer.
    // Real-mode (Sprint 5) streams from S3 by (bucket, key).
    const scanMode = this.config.get('VIRUS_SCAN_MODE', { infer: true });
    const scanResult =
      scanMode === 'off'
        ? { status: 'skipped' as const, engine: 'disabled' }
        : await this.scanner.scan({
            ...(input.scanBuffer !== undefined ? { buffer: input.scanBuffer } : {}),
            storageBucket: row.storageBucket,
            storageKey: row.storageKey,
            contentType: row.contentType,
          });

    if (scanResult.status === 'infected') {
      // The row stays uploadStatus='completed' (the bytes did upload),
      // but scanStatus='infected' means consumers won't surface it.
      // Operators can purge from S3 + delete the row out-of-band.
      const failedRow = await this.prisma.runInTenantContext(
        input.tenantId,
        'tenant',
        (tx) =>
          tx.document.update({
            where: { id: input.documentId },
            data: {
              etag,
              sizeBytes: sizeToRecord,
              uploadStatus: 'completed',
              finalizedAt: new Date(),
              scanStatus: 'infected',
              scanEngine: scanResult.engine,
              ...(scanResult.signature !== undefined
                ? { scanSignature: scanResult.signature }
                : {}),
              scannedAt: new Date(),
              uploadError: `virus signature: ${scanResult.signature ?? 'unknown'}`,
              ...(input.contentSha256 !== undefined
                ? { contentSha256: input.contentSha256 }
                : {}),
            },
          }),
      );
      void failedRow;
      throw new ValidationFailedError({
        documentId: [`Upload rejected — virus signature ${scanResult.signature ?? 'detected'}.`],
      });
    }

    const updated = await this.prisma.runInTenantContext(input.tenantId, 'tenant', (tx) =>
      tx.document.update({
        where: { id: input.documentId },
        data: {
          etag,
          sizeBytes: sizeToRecord,
          uploadStatus: 'completed',
          finalizedAt: new Date(),
          uploadError: null,
          scanStatus: scanResult.status,
          scanEngine: scanResult.engine,
          ...(scanResult.status === 'clean' ? { scannedAt: new Date() } : {}),
          ...(input.contentSha256 !== undefined ? { contentSha256: input.contentSha256 } : {}),
        },
      }),
    );

    return toDocument(updated);
  }

  async list(tenantId: string, claimId: string): Promise<Document[]> {
    const rows = await this.prisma.runInTenantContext(tenantId, 'tenant', (tx) =>
      tx.document.findMany({
        where: { claimId },
        orderBy: { uploadedAt: 'asc' },
      }),
    );
    return rows.map(toDocument);
  }

  // Used by discharge / claim-submit to gate progression on completed
  // uploads only. Pending rows don't count, infected rows don't count.
  // Skipped + clean both count — when scan mode is 'off' every row
  // ends up 'skipped' and the gate is identical to pre-Slice-S
  // behaviour.
  async hasDocumentType(
    tenantId: string,
    claimId: string,
    type: DocumentType,
  ): Promise<boolean> {
    const count = await this.prisma.runInTenantContext(tenantId, 'tenant', (tx) =>
      tx.document.count({
        where: {
          claimId,
          documentType: type,
          uploadStatus: 'completed',
          scanStatus: { in: ['clean', 'skipped'] },
        },
      }),
    );
    return count > 0;
  }

  // Slice AW — pulls EOB-shaped fields out of the document via the
  // EobOcrAdapter. Operators trigger this from the settlement screen
  // so a heavy real-OCR call doesn't slow the upload-finalize path.
  // Pre-conditions: document belongs to (tenant, claim), upload is
  // completed, scan is clean (or skipped). Anything else is a 422 —
  // running OCR against a pending / infected upload would either
  // hit empty bytes or scan-quarantined bytes.
  async extractEob(input: ExtractEobInput): Promise<EobExtractResponse> {
    const row = await this.prisma.runInTenantContext(input.tenantId, 'tenant', (tx) =>
      tx.document.findUnique({ where: { id: input.documentId } }),
    );
    if (!row || row.tenantId !== input.tenantId || row.claimId !== input.claimId) {
      throw new ValidationFailedError({ documentId: ['Document not on this claim.'] });
    }
    if (row.uploadStatus !== 'completed') {
      throw new ValidationFailedError({
        document: [`Cannot OCR a document in uploadStatus=${row.uploadStatus}.`],
      });
    }
    if (row.scanStatus !== 'clean' && row.scanStatus !== 'skipped') {
      throw new ValidationFailedError({
        document: [`Cannot OCR a document in scanStatus=${row.scanStatus}.`],
      });
    }

    const adapterInput: ExtractInput = {
      storageBucket: row.storageBucket,
      storageKey: row.storageKey,
      contentType: row.contentType,
      originalFilename: row.originalFilename,
      ...(input.buffer !== undefined ? { buffer: input.buffer } : {}),
    };
    const result = await this.eobOcr.extract(adapterInput);
    // Return the adapter's result verbatim. Persistence + auto-fill of
    // a Settlement draft is the next slice — keep this one focused on
    // the extraction surface.
    return {
      status: result.status,
      engine: result.engine,
      ...(result.fields !== undefined ? { fields: result.fields } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  }
}

function toDocument(row: {
  id: string;
  claimId: string;
  documentType: string;
  storageBucket: string;
  storageKey: string;
  etag: string | null;
  contentType: string;
  sizeBytes: number;
  originalFilename: string;
  uploadStatus: string;
  contentSha256: string | null;
  uploadError: string | null;
  finalizedAt: Date | null;
  uploadedAt: Date;
  uploadedById: string | null;
  scanStatus?: string;
  scanEngine?: string | null;
  scanSignature?: string | null;
  scannedAt?: Date | null;
}): Document {
  return {
    id: row.id,
    claimId: row.claimId,
    documentType: row.documentType as DocumentType,
    storageBucket: row.storageBucket,
    storageKey: row.storageKey,
    etag: row.etag,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    originalFilename: row.originalFilename,
    uploadStatus: row.uploadStatus as DocumentUploadStatus,
    contentSha256: row.contentSha256,
    uploadError: row.uploadError,
    finalizedAt: row.finalizedAt ? row.finalizedAt.toISOString() : null,
    uploadedAt: row.uploadedAt.toISOString(),
    uploadedById: row.uploadedById,
    scanStatus: (row.scanStatus ?? 'skipped') as Document['scanStatus'],
    scanEngine: row.scanEngine ?? null,
    scanSignature: row.scanSignature ?? null,
    scannedAt: row.scannedAt ? row.scannedAt.toISOString() : null,
  };
}
