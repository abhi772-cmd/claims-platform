// Slice BJ — unit coverage for the stub adapter's
// lookupPmjayPolicies method. Drives the deterministic fixture
// branches (single, multi, empty) so downstream consumers (the
// service + the operator-facing UI) can assert on the round-trip
// without an upstream gateway.

import { type ConfigService } from '@nestjs/config';

import { NhcxStubAdapter } from './nhcx-stub.adapter';
import { type AppConfig } from '../../config/configuration';

function makeAdapter(): NhcxStubAdapter {
  const config = {
    get(): unknown {
      return undefined;
    },
  } as unknown as ConfigService<AppConfig, true>;
  return new NhcxStubAdapter(config);
}

describe('NhcxStubAdapter.lookupPmjayPolicies (Slice BJ)', () => {
  it('non-sentinel ABHA → returns one PMJAY Rajasthan policy with values derived from the identifier', async () => {
    const a = makeAdapter();
    const r = await a.lookupPmjayPolicies({
      tenantId: 't-1',
      identifierType: 'abha',
      identifier: '91-1234-5678-9999',
    });
    expect(r.policies).toHaveLength(1);
    const p = r.policies[0]!;
    expect(p.payerId).toBe('pmjay@hcx');
    expect(p.productName).toBe('PMJAY Rajasthan');
    expect(p.memberId).toMatch(/^MEM-/);
    // Last 6 chars of identifier flow into the derived ids so the
    // operator-facing UI can assert visually on the round-trip.
    expect(p.policyNumber).toContain('PMJAY/RJ/');
  });

  it('STUB-EMPTY-* → returns no policies (beneficiary not linked)', async () => {
    const a = makeAdapter();
    const r = await a.lookupPmjayPolicies({
      tenantId: 't-1',
      identifierType: 'abha',
      identifier: 'STUB-EMPTY-AAA',
    });
    expect(r.policies).toEqual([]);
    expect(r.identifier).toBe('STUB-EMPTY-AAA');
  });

  it('STUB-MULTI-* → returns two policies with different productIds', async () => {
    const a = makeAdapter();
    const r = await a.lookupPmjayPolicies({
      tenantId: 't-1',
      identifierType: 'mobile',
      identifier: 'STUB-MULTI-9876543210',
    });
    expect(r.policies).toHaveLength(2);
    expect(r.policies[0]!.productId).toBe('PMJAY-RAN-V2');
    expect(r.policies[1]!.productId).toBe('PMJAY-PMM-V2');
  });

  it('echoes identifierType + identifier on the response', async () => {
    const a = makeAdapter();
    const r = await a.lookupPmjayPolicies({
      tenantId: 't-1',
      identifierType: 'mobile',
      identifier: '9876543210',
    });
    expect(r.identifierType).toBe('mobile');
    expect(r.identifier).toBe('9876543210');
  });
});
