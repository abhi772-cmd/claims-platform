// Service-level unit tests for KycService. The e2e
// (tenant-kyc.e2e-spec / tenant-kyc-review.e2e-spec) cover real RLS +
// audit + RBAC; here we focus on the lifecycle invariants:
//   - list() coverage math (slice ON-2 + the legal axis in ON-3)
//   - finalize requires status=uploading
//   - delete refused once past pending_review
//   - download-url refused while uploading
//   - review() lifecycle gating (only pending_review reviewable)
//   - review() flips status + writes audit
//   - recomputeDerivedSteps is invoked after every mutating call

import { KycService } from './kyc.service';

interface FakeTx {
  kycDocument: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    count: jest.Mock;
  };
  onboardingStep: {
    findUnique: jest.Mock;
    upsert: jest.Mock;
  };
  tenant: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
  };
  $executeRaw: jest.Mock;
}

function makeTx(overrides: Partial<FakeTx> = {}): FakeTx {
  return {
    kycDocument: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      ...(overrides.kycDocument ?? {}),
    },
    onboardingStep: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue(undefined),
      ...(overrides.onboardingStep ?? {}),
    },
    tenant: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      ...(overrides.tenant ?? {}),
    },
    $executeRaw: jest.fn().mockResolvedValue(undefined),
  };
}

function makePrisma(tx: FakeTx): {
  runInTenantContext: jest.Mock;
  $transaction: jest.Mock;
} {
  return {
    runInTenantContext: jest.fn(async (_tenantId, _role, cb) => cb(tx)),
    $transaction: jest.fn(async (cb) => cb(tx)),
  };
}

function makeStorage(): {
  presignUpload: jest.Mock;
  finalize: jest.Mock;
  presignDownload: jest.Mock;
  getObject: jest.Mock;
} {
  return {
    presignUpload: jest.fn().mockResolvedValue({
      storageBucket: 'b',
      storageKey: 'k',
      uploadUrl: 'stub://b/k',
      expiresAt: '2099-01-01T00:00:00.000Z',
      requiredHeaders: { 'content-type': 'application/pdf' },
    }),
    finalize: jest.fn().mockResolvedValue({ etag: 'e', actualSizeBytes: 0 }),
    presignDownload: jest.fn().mockResolvedValue({
      url: 'stub://b/k',
      expiresAt: '2099-01-01T00:00:00.000Z',
    }),
    getObject: jest.fn(),
  };
}

function makeAudit(): { recordWithTx: jest.Mock; record: jest.Mock } {
  return {
    recordWithTx: jest.fn().mockResolvedValue(undefined),
    record: jest.fn().mockResolvedValue(undefined),
  };
}

function makeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-0000-0000-000000000099',
    tenantId: 'tenant-1',
    documentType: 'hospital_registration',
    status: 'uploading',
    storageBucket: 'b',
    storageKey: 'k',
    originalFilename: 'hr.pdf',
    contentType: 'application/pdf',
    declaredSizeBytes: 1024,
    actualSizeBytes: null,
    sha256: null,
    etag: null,
    uploadedByUserId: 'user-1',
    uploadedAt: new Date('2026-05-13T00:00:00.000Z'),
    finalizedAt: null,
    reviewedByUserId: null,
    reviewedAt: null,
    reviewNotes: null,
    rejectionReasonCode: null,
    ...overrides,
  };
}

function buildSvc(tx: FakeTx): KycService {
  return new KycService(
    makePrisma(tx) as never,
    makeAudit() as never,
    makeStorage() as never,
  );
}

describe('KycService', () => {
  const tenantId = '00000000-0000-0000-0000-000000000001';
  const actorUserId = '00000000-0000-0000-0000-0000000000aa';

  describe('list()', () => {
    it('reports requiredCoverageComplete=true when all 6 KYC types have non-rejected rows', async () => {
      const types = [
        'hospital_registration',
        'rohini_registration',
        'gst_certificate',
        'pan',
        'signatory_id',
        'cancelled_cheque',
      ];
      const rows = types.map((t, i) =>
        makeRow({ id: `id-${i}`, documentType: t, status: 'pending_review' }),
      );
      const tx = makeTx({
        kycDocument: { findMany: jest.fn().mockResolvedValue(rows) } as never,
      });
      const out = await buildSvc(tx).list(tenantId);
      expect(out.requiredCoverageComplete).toBe(true);
      expect(Object.values(out.requiredCoverage).every(Boolean)).toBe(true);
      // Legal axis is independent and not satisfied here.
      expect(out.legalCoverageComplete).toBe(false);
      expect(out.opsVerificationComplete).toBe(false);
    });

    it('legalCoverageComplete tracks dpa_signed + msa_signed independently', async () => {
      const rows = [
        makeRow({ documentType: 'dpa_signed', status: 'pending_review' }),
        makeRow({ documentType: 'msa_signed', status: 'pending_review' }),
      ];
      const tx = makeTx({
        kycDocument: { findMany: jest.fn().mockResolvedValue(rows) } as never,
      });
      const out = await buildSvc(tx).list(tenantId);
      expect(out.legalCoverage.dpa_signed).toBe(true);
      expect(out.legalCoverage.msa_signed).toBe(true);
      expect(out.legalCoverageComplete).toBe(true);
      // KYC axis not satisfied.
      expect(out.requiredCoverageComplete).toBe(false);
    });

    it('opsVerificationComplete requires every required + legal type approved', async () => {
      const types = [
        'hospital_registration',
        'rohini_registration',
        'gst_certificate',
        'pan',
        'signatory_id',
        'cancelled_cheque',
        'dpa_signed',
        'msa_signed',
      ];
      const rows = types.map((t, i) =>
        makeRow({ id: `id-${i}`, documentType: t, status: 'approved' }),
      );
      const tx = makeTx({
        kycDocument: { findMany: jest.fn().mockResolvedValue(rows) } as never,
      });
      const out = await buildSvc(tx).list(tenantId);
      expect(out.opsVerificationComplete).toBe(true);
    });

    it('rejected + resubmission_requested rows do NOT count toward coverage', async () => {
      const rows = [
        makeRow({ documentType: 'hospital_registration', status: 'rejected' }),
        makeRow({ documentType: 'pan', status: 'resubmission_requested' }),
        makeRow({ documentType: 'gst_certificate', status: 'pending_review' }),
      ];
      const tx = makeTx({
        kycDocument: { findMany: jest.fn().mockResolvedValue(rows) } as never,
      });
      const out = await buildSvc(tx).list(tenantId);
      expect(out.requiredCoverage.hospital_registration).toBe(false);
      expect(out.requiredCoverage.pan).toBe(false);
      expect(out.requiredCoverage.gst_certificate).toBe(true);
      expect(out.requiredCoverageComplete).toBe(false);
    });

    it('empty tenant → every flag false', async () => {
      const out = await buildSvc(makeTx()).list(tenantId);
      expect(out.requiredCoverageComplete).toBe(false);
      expect(out.legalCoverageComplete).toBe(false);
      expect(out.opsVerificationComplete).toBe(false);
      expect(out.documents).toHaveLength(0);
    });

    it('each returned document carries a computed slaState', async () => {
      const rows = [makeRow({ status: 'pending_review' })];
      const tx = makeTx({
        kycDocument: { findMany: jest.fn().mockResolvedValue(rows) } as never,
      });
      const out = await buildSvc(tx).list(tenantId);
      expect(out.documents[0]?.slaState).toBeDefined();
    });
  });

  describe('finalize()', () => {
    it('flips uploading → pending_review, writes audit, recomputes derived steps', async () => {
      const initial = makeRow({ status: 'uploading' });
      const updated = makeRow({
        status: 'pending_review',
        etag: 'e',
        actualSizeBytes: 1024,
        finalizedAt: new Date('2026-05-13T00:00:00.000Z'),
      });
      const tx = makeTx({
        kycDocument: {
          findMany: jest.fn().mockResolvedValue([updated]),
          findUnique: jest.fn().mockResolvedValue(initial),
          create: jest.fn(),
          update: jest.fn().mockResolvedValue(updated),
          delete: jest.fn(),
          count: jest.fn(),
        },
      });
      const svc = buildSvc(tx);
      const out = await svc.finalize({
        tenantId,
        actorUserId,
        documentId: String(initial['id']),
        ip: '203.0.113.10',
        userAgent: 'jest',
      });
      expect(out.status).toBe('pending_review');
      // recompute should have called onboardingStep.upsert (3 derived steps).
      expect(tx.onboardingStep.upsert).toHaveBeenCalled();
    });

    it('rejects finalize on an already-approved row', async () => {
      const tx = makeTx({
        kycDocument: {
          findMany: jest.fn(),
          findUnique: jest.fn().mockResolvedValue(makeRow({ status: 'approved' })),
          create: jest.fn(),
          update: jest.fn(),
          delete: jest.fn(),
          count: jest.fn(),
        },
      });
      await expect(
        buildSvc(tx).finalize({
          tenantId,
          actorUserId,
          documentId: 'x',
          ip: null,
          userAgent: null,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('idempotent on a row already in pending_review (no second update)', async () => {
      const pending = makeRow({ status: 'pending_review', etag: 'e' });
      const tx = makeTx({
        kycDocument: {
          findMany: jest.fn(),
          findUnique: jest.fn().mockResolvedValue(pending),
          create: jest.fn(),
          update: jest.fn(),
          delete: jest.fn(),
          count: jest.fn(),
        },
      });
      const out = await buildSvc(tx).finalize({
        tenantId,
        actorUserId,
        documentId: String(pending['id']),
        ip: null,
        userAgent: null,
      });
      expect(out.status).toBe('pending_review');
      expect(tx.kycDocument.update).not.toHaveBeenCalled();
    });
  });

  describe('delete()', () => {
    it('allows delete while uploading + triggers recompute', async () => {
      const row = makeRow({ status: 'uploading' });
      const tx = makeTx({
        kycDocument: {
          findMany: jest.fn().mockResolvedValue([]),
          findUnique: jest.fn().mockResolvedValue(row),
          create: jest.fn(),
          update: jest.fn(),
          delete: jest.fn().mockResolvedValue(row),
          count: jest.fn(),
        },
      });
      await buildSvc(tx).delete({
        tenantId,
        actorUserId,
        documentId: String(row['id']),
        ip: null,
        userAgent: null,
      });
      expect(tx.kycDocument.delete).toHaveBeenCalled();
      expect(tx.onboardingStep.upsert).toHaveBeenCalled();
    });

    it('refuses delete once approved', async () => {
      const tx = makeTx({
        kycDocument: {
          findMany: jest.fn(),
          findUnique: jest.fn().mockResolvedValue(makeRow({ status: 'approved' })),
          create: jest.fn(),
          update: jest.fn(),
          delete: jest.fn(),
          count: jest.fn(),
        },
      });
      await expect(
        buildSvc(tx).delete({
          tenantId,
          actorUserId,
          documentId: 'x',
          ip: null,
          userAgent: null,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(tx.kycDocument.delete).not.toHaveBeenCalled();
    });
  });

  describe('getDownloadUrl()', () => {
    it('refuses while uploading (no bytes yet)', async () => {
      const tx = makeTx({
        kycDocument: {
          findMany: jest.fn(),
          findUnique: jest.fn().mockResolvedValue(makeRow({ status: 'uploading' })),
          create: jest.fn(),
          update: jest.fn(),
          delete: jest.fn(),
          count: jest.fn(),
        },
      });
      await expect(
        buildSvc(tx).getDownloadUrl(tenantId, 'x'),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('returns presigned URL once pending_review', async () => {
      const tx = makeTx({
        kycDocument: {
          findMany: jest.fn(),
          findUnique: jest.fn().mockResolvedValue(makeRow({ status: 'pending_review' })),
          create: jest.fn(),
          update: jest.fn(),
          delete: jest.fn(),
          count: jest.fn(),
        },
      });
      const out = await buildSvc(tx).getDownloadUrl(tenantId, 'x');
      expect(out.url).toMatch(/^stub:\/\//);
    });
  });

  describe('review() — slice ON-3', () => {
    it('approve flips pending_review → approved + writes audit + recomputes', async () => {
      const row = makeRow({ status: 'pending_review' });
      const updated = makeRow({ ...row, status: 'approved' });
      const tx = makeTx({
        kycDocument: {
          findMany: jest.fn().mockResolvedValue([updated]),
          findUnique: jest.fn().mockResolvedValue(row),
          create: jest.fn(),
          update: jest.fn().mockResolvedValue(updated),
          delete: jest.fn(),
          count: jest.fn(),
        },
      });
      const audit = makeAudit();
      const svc = new KycService(
        makePrisma(tx) as never,
        audit as never,
        makeStorage() as never,
      );
      const out = await svc.review({
        documentId: String(row['id']),
        reviewerUserId: 'reviewer-1',
        body: { action: 'approve' },
        ip: '203.0.113.10',
        userAgent: 'jest',
      });
      expect(out.status).toBe('approved');
      expect(audit.recordWithTx).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          action: 'TENANT_UPDATED',
          resourceType: 'kyc_document',
          after: expect.objectContaining({ status: 'approved' }),
        }),
      );
      expect(tx.onboardingStep.upsert).toHaveBeenCalled();
    });

    it('reject flips pending_review → rejected', async () => {
      const row = makeRow({ status: 'pending_review' });
      const updated = makeRow({ ...row, status: 'rejected' });
      const tx = makeTx({
        kycDocument: {
          findMany: jest.fn().mockResolvedValue([updated]),
          findUnique: jest.fn().mockResolvedValue(row),
          create: jest.fn(),
          update: jest.fn().mockResolvedValue(updated),
          delete: jest.fn(),
          count: jest.fn(),
        },
      });
      const out = await buildSvc(tx).review({
        documentId: String(row['id']),
        reviewerUserId: 'reviewer-1',
        body: { action: 'reject', rejectionReasonCode: 'illegible_scan' },
        ip: null,
        userAgent: null,
      });
      expect(out.status).toBe('rejected');
    });

    it('refuses to review a row that is not pending_review', async () => {
      const tx = makeTx({
        kycDocument: {
          findMany: jest.fn(),
          findUnique: jest.fn().mockResolvedValue(makeRow({ status: 'uploading' })),
          create: jest.fn(),
          update: jest.fn(),
          delete: jest.fn(),
          count: jest.fn(),
        },
      });
      await expect(
        buildSvc(tx).review({
          documentId: 'x',
          reviewerUserId: 'reviewer-1',
          body: { action: 'approve' },
          ip: null,
          userAgent: null,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  describe('queue() — slice ON-3', () => {
    it('decorates rows with tenant display names', async () => {
      const row = makeRow({ status: 'pending_review', tenantId: 'tenant-77' });
      const tx = makeTx({
        kycDocument: {
          findMany: jest.fn().mockResolvedValue([row]),
          findUnique: jest.fn(),
          create: jest.fn(),
          update: jest.fn(),
          delete: jest.fn(),
          count: jest.fn().mockResolvedValue(1),
        },
        tenant: {
          findMany: jest.fn().mockResolvedValue([
            { id: 'tenant-77', slug: 'apollo-indore', displayName: 'Apollo Indore' },
          ]),
          findUnique: jest.fn(),
        },
      });
      const out = await buildSvc(tx).queue({ limit: 50, offset: 0 });
      expect(out.total).toBe(1);
      expect(out.items[0]?.tenantSlug).toBe('apollo-indore');
      expect(out.items[0]?.tenantDisplayName).toBe('Apollo Indore');
    });
  });
});
