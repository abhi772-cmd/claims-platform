import { randomUUID } from 'node:crypto';

import { Prisma } from '@prisma/client';

import {
  computeKycSlaState,
  type KycDocument,
  type KycDocumentStatus,
  type KycDocumentType,
  type KycDownloadResponse,
  type KycListResponse,
  type KycReviewAction,
  type KycReviewDetail,
  type KycReviewQueueQuery,
  type KycReviewQueueResponse,
  type KycReviewRequest,
  type KycUploadInitResponse,
  LEGAL_AGREEMENT_DOCUMENT_TYPES,
  REQUIRED_KYC_DOCUMENT_TYPES,
} from '@claims/contracts';
import { Inject, Injectable } from '@nestjs/common';

import { ValidationFailedError } from '../../common/errors/validation-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { type TenantPrisma } from '../../types/express';
import { AuditEvents, AuditService } from '../audit';
import { STORAGE_ADAPTER, type StorageAdapter } from '../storage';

// Slice ON-2 of the onboarding spec diff (docs/15) — KYC document
// service. Mirrors DocumentService's init+finalize flow but scoped to
// tenant-level uploads (not per-claim) and with the new
// uploading → pending_review → (slice ON-3) approved/rejected
// lifecycle. Bytes never flow through the API server.

export interface InitKycUploadInput {
  tenantId: string;
  actorUserId: string;
  documentType: KycDocumentType;
  originalFilename: string;
  contentType: string;
  sizeBytes: number;
}

export interface FinalizeKycUploadInput {
  tenantId: string;
  actorUserId: string;
  documentId: string;
  contentSha256?: string;
  ip: string | null;
  userAgent: string | null;
}

export interface DeleteKycUploadInput {
  tenantId: string;
  actorUserId: string;
  documentId: string;
  ip: string | null;
  userAgent: string | null;
}

// The storage adapter's PresignUploadInput requires a `claimId`; for
// KYC there isn't one. We pass the literal `'kyc'` so the stub adapter
// keys land under `<tenantId>/kyc/<docId>-<filename>` and the real S3
// adapter mirrors that layout. Centralised so it doesn't drift.
const KYC_STORAGE_SCOPE = 'kyc';

@Injectable()
export class KycService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
  ) {}

  async list(tenantId: string): Promise<KycListResponse> {
    const rows = await this.prisma.runInTenantContext(tenantId, 'tenant', (tx) =>
      tx.kycDocument.findMany({
        where: { tenantId },
        orderBy: [{ uploadedAt: 'desc' }],
      }),
    );

    return buildListResponse(rows);
  }

  async initUpload(input: InitKycUploadInput): Promise<KycUploadInitResponse> {
    const documentId = randomUUID();
    const presigned = await this.storage.presignUpload({
      tenantId: input.tenantId,
      claimId: KYC_STORAGE_SCOPE,
      documentId,
      contentType: input.contentType,
      declaredSizeBytes: input.sizeBytes,
      originalFilename: input.originalFilename,
    });

    const row = await this.prisma.runInTenantContext(input.tenantId, 'tenant', (tx) =>
      tx.kycDocument.create({
        data: {
          id: documentId,
          tenantId: input.tenantId,
          documentType: input.documentType,
          status: 'uploading',
          storageBucket: presigned.storageBucket,
          storageKey: presigned.storageKey,
          contentType: input.contentType,
          declaredSizeBytes: input.sizeBytes,
          originalFilename: input.originalFilename,
          uploadedByUserId: input.actorUserId,
        },
      }),
    );

    return {
      document: toKycDocument(row),
      uploadUrl: presigned.uploadUrl,
      expiresAt: presigned.expiresAt,
      requiredHeaders: presigned.requiredHeaders,
    };
  }

  async finalize(input: FinalizeKycUploadInput): Promise<KycDocument> {
    const row = await this.prisma.runInTenantContext(input.tenantId, 'tenant', (tx) =>
      tx.kycDocument.findUnique({ where: { id: input.documentId } }),
    );
    if (!row || row.tenantId !== input.tenantId) {
      throw new ValidationFailedError({ documentId: ['KYC document not found.'] });
    }
    if (row.status === 'pending_review') {
      // Idempotent re-finalize — return the row as-is.
      return toKycDocument(row);
    }
    if (row.status !== 'uploading') {
      throw new ValidationFailedError({
        documentId: [`Cannot finalize a document in ${row.status} status.`],
      });
    }
    if (row.storageBucket === null || row.storageKey === null) {
      throw new ValidationFailedError({
        documentId: ['Document missing storage references; re-init required.'],
      });
    }

    const head = await this.storage.finalize({
      storageBucket: row.storageBucket,
      storageKey: row.storageKey,
    });
    // Stub adapter returns 0 — trust declared size in that case.
    const actualSizeBytes = head.actualSizeBytes > 0 ? head.actualSizeBytes : row.declaredSizeBytes;

    const updated = await this.prisma.runInTenantContext(
      input.tenantId,
      'tenant',
      async (tx) => {
        const next = await tx.kycDocument.update({
          where: { id: input.documentId },
          data: {
            status: 'pending_review',
            actualSizeBytes,
            etag: head.etag,
            ...(input.contentSha256 !== undefined ? { sha256: input.contentSha256 } : {}),
            finalizedAt: new Date(),
          },
        });
        await this.audit.recordWithTx(tx, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          actorType: 'user',
          action: AuditEvents.TENANT_UPDATED,
          resourceType: 'kyc_document',
          resourceId: next.id,
          before: { status: row.status },
          after: {
            status: next.status,
            documentType: next.documentType,
            actualSizeBytes: next.actualSizeBytes,
          },
          ipAddress: input.ip,
          userAgent: input.userAgent,
        });
        await recomputeDerivedSteps(tx, input.tenantId, input.actorUserId);
        return next;
      },
    );

    return toKycDocument(updated);
  }

  async delete(input: DeleteKycUploadInput): Promise<void> {
    const row = await this.prisma.runInTenantContext(input.tenantId, 'tenant', (tx) =>
      tx.kycDocument.findUnique({ where: { id: input.documentId } }),
    );
    if (!row || row.tenantId !== input.tenantId) {
      throw new ValidationFailedError({ documentId: ['KYC document not found.'] });
    }
    // Tenant may only delete docs that haven't gone past pending_review.
    // After ops acts on a row (approved / rejected / resubmission), the
    // row stays for audit and the tenant must re-upload a new row.
    const deletable: KycDocumentStatus[] = ['uploading', 'pending_review'];
    if (!deletable.includes(row.status as KycDocumentStatus)) {
      throw new ValidationFailedError({
        documentId: [`Cannot delete a document in ${row.status} status.`],
      });
    }

    await this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      await tx.kycDocument.delete({ where: { id: input.documentId } });
      await this.audit.recordWithTx(tx, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        actorType: 'user',
        action: AuditEvents.TENANT_UPDATED,
        resourceType: 'kyc_document',
        resourceId: input.documentId,
        before: { status: row.status, documentType: row.documentType },
        after: { deleted: true },
        ipAddress: input.ip,
        userAgent: input.userAgent,
      });
      await recomputeDerivedSteps(tx, input.tenantId, input.actorUserId);
    });
  }

  async getDownloadUrl(
    tenantId: string,
    documentId: string,
  ): Promise<KycDownloadResponse> {
    const row = await this.prisma.runInTenantContext(tenantId, 'tenant', (tx) =>
      tx.kycDocument.findUnique({ where: { id: documentId } }),
    );
    if (!row || row.tenantId !== tenantId) {
      throw new ValidationFailedError({ documentId: ['KYC document not found.'] });
    }
    if (row.status === 'uploading') {
      throw new ValidationFailedError({
        documentId: ['Upload not finalized yet.'],
      });
    }
    if (row.storageBucket === null || row.storageKey === null) {
      throw new ValidationFailedError({
        documentId: ['Document missing storage references.'],
      });
    }
    const presigned = await this.storage.presignDownload({
      storageBucket: row.storageBucket,
      storageKey: row.storageKey,
      downloadFilename: row.originalFilename,
    });
    return { url: presigned.url, expiresAt: presigned.expiresAt };
  }

  // Used by the OnboardingReadinessService to decide whether the
  // kyc_documents_uploaded step auto-completes.
  async hasRequiredCoverage(tenantId: string): Promise<boolean> {
    const summary = await this.list(tenantId);
    return summary.requiredCoverageComplete;
  }

  // -- Slice ON-3 — ops review queue --

  // Lists docs across tenants, filtered + paginated. Runs under the
  // platform_admin GUC so RLS lets us see every tenant; callers are
  // gated by the KYC_REVIEW permission upstream.
  async queue(query: KycReviewQueueQuery): Promise<KycReviewQueueResponse> {
    const where = {
      ...(query.status !== undefined ? { status: query.status } : { status: 'pending_review' as KycDocumentStatus }),
      ...(query.tenantId !== undefined ? { tenantId: query.tenantId } : {}),
    };
    return runAsPlatformAdmin(this.prisma, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.kycDocument.findMany({
          where,
          orderBy: [{ uploadedAt: 'asc' }],
          take: query.limit,
          skip: query.offset,
        }),
        tx.kycDocument.count({ where }),
      ]);
      const tenantIds = Array.from(new Set(rows.map((r) => r.tenantId)));
      const tenants = await tx.tenant.findMany({
        where: { id: { in: tenantIds } },
        select: { id: true, slug: true, displayName: true },
      });
      const tenantById = new Map(tenants.map((t) => [t.id, t]));
      const items = rows.map((row) => {
        const t = tenantById.get(row.tenantId);
        return {
          document: toKycDocument(row),
          tenantId: row.tenantId,
          tenantSlug: t?.slug ?? '',
          tenantDisplayName: t?.displayName ?? '',
          uploadedAt: row.uploadedAt.toISOString(),
        };
      });
      return { items, total };
    });
  }

  async getForReview(documentId: string): Promise<KycReviewDetail> {
    return runAsPlatformAdmin(this.prisma, async (tx) => {
      const row = await tx.kycDocument.findUnique({ where: { id: documentId } });
      if (!row) {
        throw new ValidationFailedError({ documentId: ['KYC document not found.'] });
      }
      if (row.storageBucket === null || row.storageKey === null) {
        throw new ValidationFailedError({
          documentId: ['Document missing storage references.'],
        });
      }
      const tenant = await tx.tenant.findUnique({
        where: { id: row.tenantId },
        select: { slug: true, displayName: true },
      });
      const presigned = await this.storage.presignDownload({
        storageBucket: row.storageBucket,
        storageKey: row.storageKey,
        downloadFilename: row.originalFilename,
      });
      return {
        item: {
          document: toKycDocument(row),
          tenantId: row.tenantId,
          tenantSlug: tenant?.slug ?? '',
          tenantDisplayName: tenant?.displayName ?? '',
          uploadedAt: row.uploadedAt.toISOString(),
        },
        download: { url: presigned.url, expiresAt: presigned.expiresAt },
      };
    });
  }

  async review(input: {
    documentId: string;
    reviewerUserId: string;
    body: KycReviewRequest;
    ip: string | null;
    userAgent: string | null;
  }): Promise<KycDocument> {
    return runAsPlatformAdmin(this.prisma, async (tx) => {
      const row = await tx.kycDocument.findUnique({ where: { id: input.documentId } });
      if (!row) {
        throw new ValidationFailedError({ documentId: ['KYC document not found.'] });
      }
      // Ops can only act on rows that have bytes — `uploading` rows
      // haven't been finalized, so there's nothing to review yet.
      if (row.status !== 'pending_review') {
        throw new ValidationFailedError({
          documentId: [`Cannot ${input.body.action} a row in ${row.status} status.`],
        });
      }
      const nextStatus: KycDocumentStatus =
        input.body.action === 'approve'
          ? 'approved'
          : input.body.action === 'reject'
            ? 'rejected'
            : 'resubmission_requested';
      const updated = await tx.kycDocument.update({
        where: { id: input.documentId },
        data: {
          status: nextStatus,
          reviewedByUserId: input.reviewerUserId,
          reviewedAt: new Date(),
          ...(input.body.notes !== undefined ? { reviewNotes: input.body.notes } : {}),
          ...(input.body.rejectionReasonCode !== undefined
            ? { rejectionReasonCode: input.body.rejectionReasonCode }
            : {}),
        },
      });
      await this.audit.recordWithTx(tx, {
        tenantId: row.tenantId,
        actorUserId: input.reviewerUserId,
        actorType: 'user',
        action: AuditEvents.TENANT_UPDATED,
        resourceType: 'kyc_document',
        resourceId: row.id,
        before: { status: row.status },
        after: {
          status: updated.status,
          action: input.body.action,
          rejectionReasonCode: updated.rejectionReasonCode,
        },
        ipAddress: input.ip,
        userAgent: input.userAgent,
      });
      // Approve / reject / resubmission requested all change the
      // ops-verification picture — recompute the derived onboarding
      // steps for this tenant inside the same tx.
      await recomputeDerivedSteps(tx, row.tenantId, input.reviewerUserId);
      return toKycDocument(updated);
    });
  }
}

type RowShape = {
  id: string;
  tenantId: string;
  documentType: string;
  status: string;
  originalFilename: string;
  contentType: string;
  declaredSizeBytes: number;
  actualSizeBytes: number | null;
  sha256: string | null;
  uploadedAt: Date;
  finalizedAt: Date | null;
  reviewedAt: Date | null;
  reviewNotes: string | null;
  rejectionReasonCode: string | null;
};

function toKycDocument(row: RowShape): KycDocument {
  const uploadedAtIso = row.uploadedAt.toISOString();
  return {
    id: row.id,
    documentType: row.documentType as KycDocumentType,
    status: row.status as KycDocumentStatus,
    originalFilename: row.originalFilename,
    contentType: row.contentType,
    declaredSizeBytes: row.declaredSizeBytes,
    actualSizeBytes: row.actualSizeBytes,
    sha256: row.sha256,
    uploadedAt: uploadedAtIso,
    finalizedAt: row.finalizedAt ? row.finalizedAt.toISOString() : null,
    slaState: computeKycSlaState({
      uploadedAt: uploadedAtIso,
      status: row.status as KycDocumentStatus,
    }),
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    reviewNotes: row.reviewNotes,
    rejectionReasonCode: row.rejectionReasonCode,
  };
}

function buildListResponse(rows: RowShape[]): KycListResponse {
  // Non-rejected coverage — counts uploading + pending_review + approved.
  // resubmission_requested + rejected do NOT count: tenant must re-upload.
  const isLive = (s: string): boolean =>
    s !== 'rejected' && s !== 'resubmission_requested';
  const isApproved = (s: string): boolean => s === 'approved';

  const requiredCoverage = Object.fromEntries(
    REQUIRED_KYC_DOCUMENT_TYPES.map((t) => [
      t,
      rows.some((r) => r.documentType === t && isLive(r.status)),
    ]),
  ) as Record<KycDocumentType, boolean>;
  const legalCoverage = Object.fromEntries(
    LEGAL_AGREEMENT_DOCUMENT_TYPES.map((t) => [
      t,
      rows.some((r) => r.documentType === t && isLive(r.status)),
    ]),
  ) as Record<KycDocumentType, boolean>;

  const requiredCoverageComplete = REQUIRED_KYC_DOCUMENT_TYPES.every(
    (t) => requiredCoverage[t] === true,
  );
  const legalCoverageComplete = LEGAL_AGREEMENT_DOCUMENT_TYPES.every(
    (t) => legalCoverage[t] === true,
  );
  const opsVerificationComplete =
    REQUIRED_KYC_DOCUMENT_TYPES.every((t) =>
      rows.some((r) => r.documentType === t && isApproved(r.status)),
    ) &&
    LEGAL_AGREEMENT_DOCUMENT_TYPES.every((t) =>
      rows.some((r) => r.documentType === t && isApproved(r.status)),
    );

  return {
    documents: rows.map(toKycDocument),
    requiredCoverage,
    requiredCoverageComplete,
    legalCoverage,
    legalCoverageComplete,
    opsVerificationComplete,
  };
}

// Opens a $transaction + sets `app.role = 'platform_admin'`. No
// tenant_id GUC, so RLS lets us see + write across every tenant.
// Mirrors the pattern in AuditRetentionSweeperService.
async function runAsPlatformAdmin<T>(
  prisma: PrismaService,
  cb: (tx: TenantPrisma) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      return cb(tx as unknown as TenantPrisma);
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}

// Recomputes the three derived onboarding steps after a KYC mutation.
// Idempotent — only writes when status would actually change so the
// audit log doesn't fill with noise. Runs inside the caller's tx so
// the mutation + recompute commit atomically.
async function recomputeDerivedSteps(
  tx: TenantPrisma,
  tenantId: string,
  actorUserId: string,
): Promise<void> {
  const rows = await tx.kycDocument.findMany({
    where: { tenantId },
    select: { documentType: true, status: true },
  });
  const summary = buildListResponse(
    rows.map((r) => ({
      // The synthesised row only needs documentType + status for the
      // coverage math; other fields are placeholders the consumer
      // never reads.
      id: '',
      tenantId,
      documentType: r.documentType,
      status: r.status,
      originalFilename: '',
      contentType: '',
      declaredSizeBytes: 0,
      actualSizeBytes: null,
      sha256: null,
      uploadedAt: new Date(0),
      finalizedAt: null,
      reviewedAt: null,
      reviewNotes: null,
      rejectionReasonCode: null,
    })),
  );

  await Promise.all([
    upsertDerivedStep(
      tx,
      tenantId,
      'kyc_documents_uploaded',
      summary.requiredCoverageComplete,
      actorUserId,
    ),
    upsertDerivedStep(
      tx,
      tenantId,
      'legal_agreements_signed',
      summary.legalCoverageComplete,
      actorUserId,
    ),
    upsertDerivedStep(
      tx,
      tenantId,
      'kyc_verified_by_ops',
      summary.opsVerificationComplete,
      actorUserId,
    ),
  ]);
}

async function upsertDerivedStep(
  tx: TenantPrisma,
  tenantId: string,
  stepKey: string,
  shouldBeComplete: boolean,
  actorUserId: string,
): Promise<void> {
  const targetStatus: 'completed' | 'pending' = shouldBeComplete ? 'completed' : 'pending';
  const existing = await tx.onboardingStep.findUnique({
    where: { tenantId_stepKey: { tenantId, stepKey } },
  });
  if (existing && existing.status === targetStatus) {
    return; // no-op — keeps audit log clean
  }
  await tx.onboardingStep.upsert({
    where: { tenantId_stepKey: { tenantId, stepKey } },
    create: {
      tenantId,
      stepKey,
      status: targetStatus,
      evidence: { derived: true } as never,
      completedAt: shouldBeComplete ? new Date() : null,
      completedBy: actorUserId,
    },
    update: {
      status: targetStatus,
      completedAt: shouldBeComplete ? new Date() : null,
      completedBy: actorUserId,
    },
  });
}
