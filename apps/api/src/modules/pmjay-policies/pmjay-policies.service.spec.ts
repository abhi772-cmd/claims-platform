// Slice BJ — unit tests for PmjayPoliciesService. Tenant gate +
// adapter pass-through. We hand-roll a stub TenantService and a
// stub adapter so the test stays unit-shaped (no Postgres).

import { PmjayPoliciesService } from './pmjay-policies.service';
import {
  type AdapterPmjayPolicyLookupInput,
  type AdapterPmjayPolicyLookupResult,
  type NhcxAdapter,
} from '../nhcx';
import { type TenantService } from '../tenant/tenant.service';

function makeTenants(pmjayMode: string | null): TenantService {
  return {
    findById: async () =>
      pmjayMode === null
        ? null
        : {
            id: 't-1',
            slug: 't',
            displayName: 'T',
            lifecycleState: 'ACTIVE',
            pmjayMode,
          },
  } as unknown as TenantService;
}

function makeAdapter(result: AdapterPmjayPolicyLookupResult): NhcxAdapter {
  return {
    lookupPmjayPolicies: async (_: AdapterPmjayPolicyLookupInput) => result,
    // Other methods are not exercised in this spec — they throw if called
    // so a regression that wires the wrong method gets caught.
  } as unknown as NhcxAdapter;
}

const fixture: AdapterPmjayPolicyLookupResult = {
  policies: [
    {
      payerId: 'pmjay@hcx',
      memberId: 'MEM-AAAAAA',
      productId: 'PMJAY-RAN-V2',
      productName: 'PMJAY Rajasthan',
      policyNumber: 'PMJAY/RJ/AAAAAA',
    },
  ],
  identifierType: 'abha',
  identifier: '12345678901234',
};

describe('PmjayPoliciesService', () => {
  it('PMJAY tenant: returns adapter result verbatim', async () => {
    const svc = new PmjayPoliciesService(makeTenants('on'), makeAdapter(fixture));
    const r = await svc.lookup({
      tenantId: 't-1',
      identifierType: 'abha',
      identifier: '12345678901234',
    });
    expect(r.policies).toEqual(fixture.policies);
    expect(r.identifierType).toBe('abha');
    expect(r.identifier).toBe('12345678901234');
  });

  it('non-PMJAY tenant: rejects at tenant gate', async () => {
    const svc = new PmjayPoliciesService(makeTenants('off'), makeAdapter(fixture));
    await expect(
      svc.lookup({
        tenantId: 't-1',
        identifierType: 'abha',
        identifier: '12345678901234',
      }),
    ).rejects.toMatchObject({
      errors: { tenant: ['PMJAY policies lookup is currently a PMJAY-only operation.'] },
    });
  });

  it('unknown tenant: rejects at tenant gate (treated as non-PMJAY)', async () => {
    const svc = new PmjayPoliciesService(makeTenants(null), makeAdapter(fixture));
    await expect(
      svc.lookup({
        tenantId: 't-1',
        identifierType: 'abha',
        identifier: '12345678901234',
      }),
    ).rejects.toMatchObject({
      errors: { tenant: ['PMJAY policies lookup is currently a PMJAY-only operation.'] },
    });
  });
});
