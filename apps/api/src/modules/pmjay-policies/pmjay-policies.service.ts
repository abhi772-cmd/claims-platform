// Slice BJ — PMJAY beneficiary policies lookup. Pre-eligibility step
// where the operator enters an ABHA / mobile and the API returns
// the matching PMJAY policies. PMJAY-only — non-PMJAY tenants get a
// clean 422 at the gate.
//
// The service is intentionally thin: tenant gate → adapter call →
// pass-through. No persistence in this slice; caching by patientId
// (as suggested by the NHCX PMJAY Integration Handbook §5.6) is a
// follow-up after the patient model is wired into the lookup flow.

import { Inject, Injectable } from '@nestjs/common';

import { ValidationFailedError } from '../../common/errors/validation-errors';
import {
  type AdapterPmjayLookupIdentifierType,
  NHCX_ADAPTER,
  type NhcxAdapter,
} from '../nhcx';
import { TenantService } from '../tenant/tenant.service';

export interface LookupPmjayPoliciesInput {
  tenantId: string;
  identifierType: AdapterPmjayLookupIdentifierType;
  identifier: string;
}

export interface LookupPmjayPoliciesResult {
  policies: Array<{
    payerId: string;
    memberId: string;
    productId: string;
    productName: string;
    policyNumber: string;
  }>;
  identifierType: AdapterPmjayLookupIdentifierType;
  identifier: string;
}

@Injectable()
export class PmjayPoliciesService {
  constructor(
    private readonly tenants: TenantService,
    @Inject(NHCX_ADAPTER) private readonly nhcx: NhcxAdapter,
  ) {}

  async lookup(input: LookupPmjayPoliciesInput): Promise<LookupPmjayPoliciesResult> {
    const tenant = await this.tenants.findById(input.tenantId);
    if (tenant?.pmjayMode !== 'on') {
      throw new ValidationFailedError({
        tenant: ['PMJAY policies lookup is currently a PMJAY-only operation.'],
      });
    }
    const result = await this.nhcx.lookupPmjayPolicies({
      tenantId: input.tenantId,
      identifierType: input.identifierType,
      identifier: input.identifier,
    });
    return {
      policies: result.policies,
      identifierType: result.identifierType,
      identifier: result.identifier,
    };
  }
}
