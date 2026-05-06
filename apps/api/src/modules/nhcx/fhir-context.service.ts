import { Injectable, Logger } from '@nestjs/common';

import {
  type AdapterCoverageFields,
  type AdapterPatientFields,
} from './nhcx-adapter.interface';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PatientService } from '../patient';

// FhirContext bundles the patient + coverage fields the NHCX FHIR R4
// builders need. The eligibility service constructs this inline; the
// other phase services (preauth, discharge, claim-submit) share this
// helper so we don't repeat the case → patient → decrypted-PII walk
// in five places.
//
// Coverage is only populated when the case carries a payer code.
// When the case has no Patient row (legacy Sprint 2 cases), patient
// is built from the case's plaintext fields only — abhaId / policyNumber
// stay undefined, the adapter falls back to the legacy lightweight
// payload, and ops sees a NULL FHIR Bundle on the wire instead of
// crashing on a missing field.
export interface FhirContext {
  patient?: AdapterPatientFields;
  coverage?: AdapterCoverageFields;
}

@Injectable()
export class FhirContextService {
  private readonly log = new Logger(FhirContextService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly patients: PatientService,
  ) {}

  async build(tenantId: string, claimId: string): Promise<FhirContext> {
    const ctx = await this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const claim = await tx.claim.findUnique({
        where: { id: claimId },
        select: { caseId: true, tenantId: true, payerCode: true },
      });
      if (!claim) return null;
      const c = await tx.case.findUnique({
        where: { id: claim.caseId },
        select: {
          patientId: true,
          patientName: true,
          hospitalMrn: true,
        },
      });
      if (!c) return null;
      return {
        patientId: c.patientId,
        patientName: c.patientName,
        hospitalMrn: c.hospitalMrn,
        payerCode: claim.payerCode,
      };
    });
    if (!ctx) {
      this.log.warn(`FHIR context: claim ${claimId} not found`);
      return {};
    }
    const decrypted = ctx.patientId
      ? await this.patients.getDecrypted(tenantId, ctx.patientId)
      : null;
    const patient: AdapterPatientFields = {
      fullName: ctx.patientName,
      hospitalMrn: ctx.hospitalMrn,
      ...(decrypted?.dateOfBirth ? { dateOfBirth: decrypted.dateOfBirth } : {}),
      ...(decrypted?.gender
        ? {
            gender: decrypted.gender as
              | 'male'
              | 'female'
              | 'other'
              | 'prefer_not_to_say',
          }
        : {}),
      ...(decrypted?.abhaId ? { abhaId: decrypted.abhaId } : {}),
      ...(decrypted?.policyNumber ? { policyNumber: decrypted.policyNumber } : {}),
    };
    const coverage: AdapterCoverageFields | undefined = ctx.payerCode
      ? {
          payerCode: ctx.payerCode,
          memberId: decrypted?.policyNumber ?? ctx.hospitalMrn,
        }
      : undefined;
    return {
      patient,
      ...(coverage !== undefined ? { coverage } : {}),
    };
  }
}
