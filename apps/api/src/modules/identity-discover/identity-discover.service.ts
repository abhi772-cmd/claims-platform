// Phase 4 — smart identity-discovery orchestrator. Composes the
// three existing discovery surfaces (PMJAY policies/lookup, NHCX
// verify-by-identifiers, NHCX discover-by-mobile) and runs each
// supplied identifier against the rails that index by it. Returns
// the union of matches plus per-attempt diagnostic so the UI can
// show what was tried and why.

import { Injectable, Logger } from '@nestjs/common';

import {
  type IdentityDiscoverCandidate,
  type IdentityDiscoverResponse,
} from '@claims/contracts';

import { EligibilityService } from '../eligibility/eligibility.service';
import { PmjayPoliciesService } from '../pmjay-policies/pmjay-policies.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';

interface OrchestratorInput {
  tenantId: string;
  mobile?: string;
  abhaId?: string;
  aadhaar?: string;
  policyNumber?: string;
  patientName?: string;
  hospitalMrn?: string;
}

type Attempt = IdentityDiscoverResponse['attempts'][number];

@Injectable()
export class IdentityDiscoverService {
  private readonly log = new Logger(IdentityDiscoverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenants: TenantService,
    private readonly pmjayPolicies: PmjayPoliciesService,
    private readonly eligibility: EligibilityService,
  ) {}

  async discover(input: OrchestratorInput): Promise<IdentityDiscoverResponse> {
    const candidates: IdentityDiscoverCandidate[] = [];
    const attempts: Attempt[] = [];

    const tenant = await this.tenants.findById(input.tenantId);
    const pmjayEnabled = tenant?.pmjayMode === 'on';

    // 1. Policy number — NHCX-only path. Most specific identifier;
    // try first so we short-circuit when the operator already has it.
    if (input.policyNumber) {
      attempts.push(
        await this.tryNhcxVerify(
          input,
          'policy',
          { policyNumber: input.policyNumber },
          candidates,
        ),
      );
    }

    // 2. ABHA — PMJAY first (cheapest), then NHCX verify.
    if (input.abhaId) {
      if (pmjayEnabled) {
        attempts.push(await this.tryPmjayLookup(input, 'abha', input.abhaId, candidates));
      } else {
        attempts.push({
          identifierKind: 'abha',
          source: 'pmjay_policies_lookup',
          outcome: 'skipped',
          errorMessage: null,
        });
      }
      attempts.push(
        await this.tryNhcxVerify(input, 'abha', { abhaId: input.abhaId }, candidates),
      );
    }

    // 3. Aadhaar — PMJAY first, then NHCX verify.
    if (input.aadhaar) {
      if (pmjayEnabled) {
        attempts.push(
          await this.tryPmjayLookup(input, 'aadhaar', input.aadhaar, candidates, 'abha'),
        );
      }
      attempts.push(
        await this.tryNhcxVerify(input, 'aadhaar', { aadhaar: input.aadhaar }, candidates),
      );
    }

    // 4. Mobile — PMJAY first, then per-payer NHCX discover-by-mobile
    // fan-out across opted-in payers.
    if (input.mobile) {
      if (pmjayEnabled) {
        attempts.push(
          await this.tryPmjayLookup(input, 'mobile', input.mobile, candidates, 'mobile'),
        );
      }
      const optedInPayers = await this.optedInPayersForMobile(input.tenantId);
      for (const payer of optedInPayers) {
        attempts.push(
          await this.tryNhcxDiscoverByMobile(input, payer.code, payer.name, candidates),
        );
      }
    }

    return {
      candidates,
      attempts,
      suggestedNextStep: this.pickSuggestion(candidates, input, pmjayEnabled),
    };
  }

  private async tryPmjayLookup(
    input: OrchestratorInput,
    identifierKind: 'abha' | 'aadhaar' | 'mobile',
    identifier: string,
    sink: IdentityDiscoverCandidate[],
    // PMJAY's lookup only accepts 'abha' or 'mobile'. Aadhaar callers
    // pass 'abha' here since the PMJAY gateway treats Aadhaar as the
    // derivation source for ABHA.
    lookupIdentifierType: 'abha' | 'mobile' = identifierKind === 'mobile' ? 'mobile' : 'abha',
  ): Promise<Attempt> {
    try {
      const res = await this.pmjayPolicies.lookup({
        tenantId: input.tenantId,
        identifierType: lookupIdentifierType,
        identifier,
      });
      for (const p of res.policies) {
        sink.push({
          source: 'pmjay_policies_lookup',
          identifierKind,
          identifierValue: identifier,
          payerCode: p.payerId,
          payerName: p.productName,
          policyNumber: p.policyNumber,
          productName: p.productName,
          memberId: p.memberId,
          sumInsuredRupees: null,
        });
      }
      return {
        identifierKind,
        source: 'pmjay_policies_lookup',
        outcome: res.policies.length > 0 ? 'matched' : 'not_found',
        errorMessage: null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'PMJAY lookup failed.';
      this.log.warn(`pmjay lookup attempt failed: ${msg}`);
      return {
        identifierKind,
        source: 'pmjay_policies_lookup',
        outcome: 'error',
        errorMessage: msg.slice(0, 500),
      };
    }
  }

  private async tryNhcxVerify(
    input: OrchestratorInput,
    identifierKind: 'policy' | 'abha' | 'aadhaar',
    bodyFragment: { policyNumber?: string; abhaId?: string; aadhaar?: string },
    sink: IdentityDiscoverCandidate[],
  ): Promise<Attempt> {
    // verify-by-identifiers needs a payerCode. The orchestrator
    // fans out across every NHCX payer the tenant has access to and
    // takes the first match. Cost: N parallel calls. We cap at 5
    // payers per identifier to keep the response time bounded for
    // tenants with long payer lists.
    const nhcxPayers = await this.nhcxPayers(input.tenantId);
    let matched = false;
    let firstError: string | null = null;

    for (const payer of nhcxPayers.slice(0, 5)) {
      try {
        const verify = await this.eligibility.verifyByIdentifiers(input.tenantId, {
          patientName: input.patientName ?? 'Identity Discovery',
          hospitalMrn: input.hospitalMrn ?? 'PENDING',
          payerCode: payer.code,
          ...bodyFragment,
        });
        if (verify.verified) {
          matched = true;
          const identifierValue =
            bodyFragment.policyNumber ?? bodyFragment.abhaId ?? bodyFragment.aadhaar ?? '';
          sink.push({
            source: 'nhcx_verify_by_identifiers',
            identifierKind,
            identifierValue,
            payerCode: payer.code,
            payerName: payer.name,
            policyNumber: bodyFragment.policyNumber ?? null,
            productName: verify.planName,
            memberId: null,
            sumInsuredRupees: verify.sumInsuredRupees,
          });
        }
      } catch (err) {
        if (!firstError && err instanceof Error) firstError = err.message;
      }
    }

    return {
      identifierKind,
      source: 'nhcx_verify_by_identifiers',
      outcome: matched ? 'matched' : firstError ? 'error' : 'not_found',
      errorMessage: firstError ? firstError.slice(0, 500) : null,
    };
  }

  private async tryNhcxDiscoverByMobile(
    input: OrchestratorInput,
    payerCode: string,
    payerName: string,
    sink: IdentityDiscoverCandidate[],
  ): Promise<Attempt> {
    if (!input.mobile) {
      return {
        identifierKind: 'mobile',
        source: 'nhcx_discover_by_mobile',
        outcome: 'skipped',
        errorMessage: null,
      };
    }
    try {
      const res = await this.eligibility.discoverByMobile(input.tenantId, {
        payerCode,
        mobile: input.mobile,
        ...(input.patientName ? { patientName: input.patientName } : {}),
        ...(input.hospitalMrn ? { hospitalMrn: input.hospitalMrn } : {}),
      });
      if (res.verified && res.policyNumber) {
        sink.push({
          source: 'nhcx_discover_by_mobile',
          identifierKind: 'mobile',
          identifierValue: input.mobile,
          payerCode,
          payerName,
          policyNumber: res.policyNumber,
          productName: res.planName,
          memberId: null,
          sumInsuredRupees: res.sumInsuredRupees,
        });
        return {
          identifierKind: 'mobile',
          source: 'nhcx_discover_by_mobile',
          outcome: 'matched',
          errorMessage: null,
        };
      }
      return {
        identifierKind: 'mobile',
        source: 'nhcx_discover_by_mobile',
        outcome: 'not_found',
        errorMessage: null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'NHCX mobile discovery failed.';
      return {
        identifierKind: 'mobile',
        source: 'nhcx_discover_by_mobile',
        outcome: 'error',
        errorMessage: msg.slice(0, 500),
      };
    }
  }

  private async nhcxPayers(
    tenantId: string,
  ): Promise<Array<{ code: string; name: string }>> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const rows = await tx.payer.findMany({
        where: { rail: 'nhcx', active: true },
        orderBy: { name: 'asc' },
        select: { code: true, name: true },
      });
      return rows;
    });
  }

  private async optedInPayersForMobile(
    tenantId: string,
  ): Promise<Array<{ code: string; name: string }>> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const rows = await tx.payer.findMany({
        where: { rail: 'nhcx', active: true, supportsDiscoveryByMobile: true },
        orderBy: { name: 'asc' },
        select: { code: true, name: true },
      });
      return rows;
    });
  }

  private pickSuggestion(
    candidates: IdentityDiscoverCandidate[],
    input: OrchestratorInput,
    pmjayEnabled: boolean,
  ): IdentityDiscoverResponse['suggestedNextStep'] {
    if (candidates.length > 0) return 'none';
    // No matches across any identifier. Recommend based on what the
    // operator gave us:
    //   - has aadhaar but no abha: suggest creating one
    //   - has aadhaar + abha but still nothing: contact payer
    //   - has neither: ask for a policy number
    if (input.aadhaar && !input.abhaId && pmjayEnabled) return 'create_abha';
    if (input.policyNumber || input.abhaId) return 'contact_payer_helpline';
    return 'ask_for_policy_number';
  }
}
