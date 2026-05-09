import { Injectable, Logger } from '@nestjs/common';

import {
  type AdapterCoverageFields,
  type AdapterPatientFields,
} from './nhcx-adapter.interface';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ConsentService } from '../consent/consent.module';
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

// Slice CB — purposes a caller can declare when building a FHIR
// context. Used both for the data_access_event ledger row's
// purpose field and for the consent lookup. Conventional values
// match what callers already pass into PatientService.getDecrypted
// ctx.purpose so the access ledger stays greppable.
export type FhirContextPurpose =
  | 'eligibility.verify'
  | 'preauth.submit'
  | 'preauth.cancel'
  | 'preauth.respond_query'
  | 'claim.submit'
  | 'claim.reprocess'
  | 'discharge.submit'
  | 'communication.send';

export interface FhirContextConsentInput {
  // Actor on whose behalf the read happens. Null for system-driven
  // flows (callbacks, scheduler-fed reprocess).
  actorUserId: string | null;
  actorType?: 'user' | 'system' | 'scheduled';
  purpose: FhirContextPurpose;
  correlationId?: string | null;
}

@Injectable()
export class FhirContextService {
  private readonly log = new Logger(FhirContextService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly patients: PatientService,
    private readonly consents: ConsentService,
  ) {}

  // Slice CB — `consent` is optional for backwards compatibility.
  // When supplied, the service:
  //   1. Resolves the appropriate consent type from `tenant.pmjayMode`
  //      (PMJAY tenants need 'pmjay_processing'; others need
  //      'nhcx_processing').
  //   2. Calls ConsentService.findActiveFor — best-effort. If a
  //      grant exists, the resulting consentGrantId is threaded
  //      into PatientService.getDecrypted ctx so the
  //      data_access_event row binds back to the grant.
  //   3. If no grant exists, the read still proceeds (soft
  //      enforcement) but the access-ledger row records
  //      consentGrantId=null. The BU dashboard's
  //      `unboundAccessCountLast24h` surfaces these for triage.
  // Hard enforcement (throwing when no grant exists) is a future
  // slice gated on a tenant-level `requireConsent` flag — turning
  // it on tenant-wide before consent capture is wired into intake
  // would break every preauth submit on tenants that haven't
  // backfilled grants yet.
  async build(
    tenantId: string,
    claimId: string,
    consent?: FhirContextConsentInput,
  ): Promise<FhirContext> {
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

    // Slice CB — best-effort consent lookup when caller threaded a
    // purpose through. We pick the consent type from the tenant's
    // pmjayMode so PMJAY tenants bind against 'pmjay_processing'
    // and the rest bind against 'nhcx_processing'. Null result is
    // fine — read proceeds under legitimate_use and the access
    // ledger surfaces the gap.
    let consentGrantId: string | null = null;
    if (consent && ctx.patientId) {
      const consentType = await this.resolveConsentType(tenantId);
      const grant = await this.consents.findActiveFor(tenantId, ctx.patientId, consentType);
      consentGrantId = grant?.id ?? null;
      if (!grant) {
        this.log.debug(
          `consent gap: tenantId=${tenantId} patientId=${ctx.patientId} type=${consentType} purpose=${consent.purpose}`,
        );
      }
    }

    const decrypted = ctx.patientId
      ? await this.patients.getDecrypted(
          tenantId,
          ctx.patientId,
          consent
            ? {
                actorUserId: consent.actorUserId,
                actorType: consent.actorType ?? 'user',
                purpose: consent.purpose,
                correlationId: consent.correlationId ?? null,
                consentGrantId,
              }
            : undefined,
        )
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

  // Resolves which consent type applies for this tenant. PMJAY
  // tenants run under 'pmjay_processing' (the rail-specific notice
  // wording covers PMJAY's data-sharing arrangement). Everyone else
  // runs under 'nhcx_processing'. Tenant-table reads must run inside
  // a tenant-context tx — see the BG lesson in the Sprint 7 exit
  // doc. Falls back to 'nhcx_processing' if the tenant row is missing,
  // which can't happen in practice since the claim's RLS already
  // gates by tenantId.
  private async resolveConsentType(tenantId: string): Promise<'nhcx_processing' | 'pmjay_processing'> {
    const tenant = await this.prisma.runInTenantContext(tenantId, 'tenant', (tx) =>
      tx.tenant.findUnique({ where: { id: tenantId }, select: { pmjayMode: true } }),
    );
    return tenant?.pmjayMode === 'on' ? 'pmjay_processing' : 'nhcx_processing';
  }
}
