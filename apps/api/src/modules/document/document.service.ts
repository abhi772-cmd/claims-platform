import { randomUUID } from 'node:crypto';

import { type Document, type DocumentType } from '@claims/contracts';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';

export interface UploadStubInput {
  tenantId: string;
  claimId: string;
  actorUserId: string;
  documentType: DocumentType;
  originalFilename: string;
  contentType: string;
  sizeBytes: number;
}

@Injectable()
export class DocumentService {
  constructor(private readonly prisma: PrismaService) {}

  // V1 stub: synthesise a storage key + bucket. The real upload pipeline
  // (presigned URLs, virus scan, etc.) lands in Slice P.
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
        },
      }),
    );
    return toDocument(row);
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

  async hasDocumentType(
    tenantId: string,
    claimId: string,
    type: DocumentType,
  ): Promise<boolean> {
    const count = await this.prisma.runInTenantContext(tenantId, 'tenant', (tx) =>
      tx.document.count({ where: { claimId, documentType: type } }),
    );
    return count > 0;
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
  uploadedAt: Date;
  uploadedById: string | null;
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
    uploadedAt: row.uploadedAt.toISOString(),
    uploadedById: row.uploadedById,
  };
}
