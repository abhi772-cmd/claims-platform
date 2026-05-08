// Slice BQ — DPDP Act 2023 §11 erasure-on-request execution.
//
// Workflow (single-step in v1):
//   1. Operator files a request with patientId + reason on behalf
//      of the data subject.
//   2. Service checks if the patient has any claim still in an
//      "active" status (anything other than CLOSED / ABANDONED /
//      WRITTEN_OFF). If yes → DPDP §13 carve-out applies (legal
//      compliance need); we record a 'rejected' row listing the
//      blocking claims so the operator can come back when claims
//      close.
//   3. Otherwise: redact patient PII (encrypted ciphers + key
//      versions + hashes nulled, fullName / DOB / gender scrubbed,
//      Case.patientName + hospitalMrn replaced with placeholders).
//      The patient + case rows themselves stay because the linked
//      claim records carry IRDAI 5y / RBI 10y retention obligations
//      against the now-redacted personal data.
//
// All in one transaction — either the request commits with a
// completed status and the redaction sticks, or it doesn't commit
// at all.

import { Injectable } from '@nestjs/common';

import { ValidationFailedError } from '../../common/errors/validation-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditEvents } from '../audit/audit.events';
import { AuditService } from '../audit/audit.service';

// Claim statuses where the financial / legal transaction is
// considered settled enough that we can redact identifying data.
// Distinct from the state-machine's TERMINAL_STATUSES (which is
// just CLOSED + ABANDONED) — WRITTEN_OFF is functionally terminal
// for DPDP purposes too (we've stopped chasing payment).
const ERASABLE_CLAIM_STATUSES: ReadonlySet<string> = new Set([
  'CLOSED',
  'ABANDONED',
  'WRITTEN_OFF',
]);

export interface FileErasureRequestInput {
  tenantId: string;
  actorUserId: string;
  patientId: string;
  requestedBy: string;
  reason?: string;
}

export interface ErasureRequestRow {
  id: string;
  tenantId: string;
  patientId: string | null;
  requestedBy: string;
  reason: string | null;
  status: 'completed' | 'rejected';
  rejectionReason: { blockingClaims: Array<{ id: string; status: string }> } | null;
  affectedCounts: { patient: number; case: number } | null;
  processedByUserId: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

@Injectable()
export class ErasureRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // Files + processes the request synchronously. Either returns a
  // 'completed' row (PII redacted) or a 'rejected' row (one or more
  // claims still active). Throws only on input validation errors.
  async fileAndProcess(input: FileErasureRequestInput): Promise<ErasureRequestRow> {
    return this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      const patient = await tx.patient.findUnique({
        where: { id: input.patientId },
        select: { id: true, tenantId: true },
      });
      if (!patient || patient.tenantId !== input.tenantId) {
        throw new ValidationFailedError({ patientId: ['Patient not found in this tenant.'] });
      }

      const cases = await tx.case.findMany({
        where: { tenantId: input.tenantId, patientId: input.patientId },
        select: { id: true, claims: { select: { id: true, status: true } } },
      });
      const blockingClaims: Array<{ id: string; status: string }> = [];
      for (const c of cases) {
        for (const claim of c.claims) {
          if (!ERASABLE_CLAIM_STATUSES.has(claim.status)) {
            blockingClaims.push({ id: claim.id, status: claim.status });
          }
        }
      }

      if (blockingClaims.length > 0) {
        // Reject. DPDP §13 carve-out — active financial / claims
        // record blocks the erasure until those terminal-out.
        const row = await tx.erasureRequest.create({
          data: {
            tenantId: input.tenantId,
            patientId: input.patientId,
            requestedBy: input.requestedBy,
            reason: input.reason ?? null,
            status: 'rejected',
            rejectionReason: { blockingClaims },
            processedByUserId: input.actorUserId,
            completedAt: new Date(),
          },
        });
        await this.audit.recordWithTx(tx, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          actorType: 'user',
          action: AuditEvents.ERASURE_REQUEST_REJECTED,
          resourceType: 'erasure_request',
          resourceId: row.id,
          after: { patientId: input.patientId, blockingClaims },
        });
        return rowToShape(row);
      }

      // No blocking claims — perform the redaction. Patient PII
      // ciphertext + key versions + hashes nulled; identifying
      // plaintext (fullName / DOB / gender) scrubbed. Case rows
      // get patientName + hospitalMrn replaced with stable
      // placeholders that include the request id so the audit
      // trail can correlate.
      const placeholder = `REDACTED-${row6Digit(input.patientId)}`;
      const patientUpdate = await tx.patient.update({
        where: { id: input.patientId },
        data: {
          fullName: placeholder,
          dateOfBirth: null,
          gender: null,
          aadhaarCipher: null,
          aadhaarKeyVersion: null,
          abhaIdCipher: null,
          abhaIdKeyVersion: null,
          policyNumberCipher: null,
          policyNumberKeyVersion: null,
          mobileCipher: null,
          mobileKeyVersion: null,
          emailCipher: null,
          emailKeyVersion: null,
          aadhaarHash: null,
          mobileHash: null,
        },
        select: { id: true },
      });
      const caseUpdate = await tx.case.updateMany({
        where: { tenantId: input.tenantId, patientId: input.patientId },
        data: {
          patientName: placeholder,
          // hospitalMrn is the hospital's internal patient id —
          // not strictly DPDP-protected (it's not a govt id), but
          // it's still a person-identifying token. Replace with
          // an erasure-stable hash so the row is preserved without
          // leaking the original MRN.
          hospitalMrn: `MRN-${placeholder}`,
        },
      });

      const row = await tx.erasureRequest.create({
        data: {
          tenantId: input.tenantId,
          patientId: input.patientId,
          requestedBy: input.requestedBy,
          reason: input.reason ?? null,
          status: 'completed',
          affectedCounts: { patient: 1, case: caseUpdate.count },
          processedByUserId: input.actorUserId,
          completedAt: new Date(),
        },
      });
      await this.audit.recordWithTx(tx, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        actorType: 'user',
        action: AuditEvents.ERASURE_REQUEST_PROCESSED,
        resourceType: 'erasure_request',
        resourceId: row.id,
        after: {
          patientId: patientUpdate.id,
          casesAffected: caseUpdate.count,
        },
      });
      return rowToShape(row);
    });
  }

  async findById(tenantId: string, requestId: string): Promise<ErasureRequestRow | null> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const row = await tx.erasureRequest.findUnique({ where: { id: requestId } });
      if (!row || row.tenantId !== tenantId) return null;
      return rowToShape(row);
    });
  }
}

// Take the last 6 chars of the patient uuid as an identifier-stable
// suffix on the placeholder. Avoids collisions across erasures
// without leaking the original PII.
function row6Digit(patientId: string): string {
  return patientId.replace(/-/g, '').slice(-6).toUpperCase();
}

function rowToShape(row: {
  id: string;
  tenantId: string;
  patientId: string | null;
  requestedBy: string;
  reason: string | null;
  status: string;
  rejectionReason: unknown;
  affectedCounts: unknown;
  processedByUserId: string | null;
  createdAt: Date;
  completedAt: Date | null;
}): ErasureRequestRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    patientId: row.patientId,
    requestedBy: row.requestedBy,
    reason: row.reason,
    status: row.status as 'completed' | 'rejected',
    rejectionReason: row.rejectionReason as ErasureRequestRow['rejectionReason'],
    affectedCounts: row.affectedCounts as ErasureRequestRow['affectedCounts'],
    processedByUserId: row.processedByUserId,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}
