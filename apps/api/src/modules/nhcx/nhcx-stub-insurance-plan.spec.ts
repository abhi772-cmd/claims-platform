// GAP_ANALYSIS row 1.13 — unit coverage for the stub adapter's
// requestInsurancePlan method. Pins the env-driven fail branch +
// the synchronous-ack contract so the InsurancePlanService can
// assume both shapes without an upstream gateway.

import { type ConfigService } from '@nestjs/config';

import { NhcxStubAdapter } from './nhcx-stub.adapter';
import { type AppConfig } from '../../config/configuration';

function makeAdapter(failList: string): NhcxStubAdapter {
  const config = {
    get(key: string): unknown {
      if (key === 'NHCX_STUB_INSURANCEPLAN_FAIL') return failList;
      return undefined;
    },
  } as unknown as ConfigService<AppConfig, true>;
  return new NhcxStubAdapter(config);
}

describe('NhcxStubAdapter.requestInsurancePlan (GAP_ANALYSIS row 1.13)', () => {
  it('default → acknowledged with a fresh correlation id and stub plan preview', async () => {
    const a = makeAdapter('');
    const r = await a.requestInsurancePlan({
      tenantId: 't-1',
      payerCode: 'pay@hcx',
      policyNumber: 'POL-OK',
      providerId: 'HFR-1',
    });
    expect(r.acknowledged).toBe(true);
    expect(r.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    // The stub previews the plan synchronously so the dev UI has
    // something to render. Production gets these via on_request.
    expect((r.rawResponse as Record<string, unknown>)['stubPreviewPlanName']).toBe(
      'Stub Star Health Gold 2026',
    );
  });

  it('policy in NHCX_STUB_INSURANCEPLAN_FAIL → acknowledged=false + failureReason', async () => {
    const a = makeAdapter('POL-BAD,POL-WRONG');
    const r = await a.requestInsurancePlan({
      tenantId: 't-1',
      payerCode: 'pay@hcx',
      policyNumber: 'POL-BAD',
      providerId: 'HFR-1',
    });
    expect(r.acknowledged).toBe(false);
    const rsp = r.rawResponse as Record<string, unknown>;
    expect(rsp['outcome']).toBe('not_found');
    expect(rsp['failureReason']).toMatch(/not recognised/i);
  });

  it('echoes the request inputs onto rawRequest for ledger visibility', async () => {
    const a = makeAdapter('');
    const r = await a.requestInsurancePlan({
      tenantId: 't-99',
      claimId: 'claim-7',
      payerCode: 'pay@hcx',
      policyNumber: 'POL-X',
      providerId: 'HFR-9',
    });
    const req = r.rawRequest as Record<string, unknown>;
    expect(req['operation']).toBe('insuranceplan/request');
    expect(req['tenantId']).toBe('t-99');
    expect(req['claimId']).toBe('claim-7');
    expect(req['policyNumber']).toBe('POL-X');
    expect(req['providerId']).toBe('HFR-9');
  });

  it('every call gets a fresh correlation id (no chain leakage)', async () => {
    const a = makeAdapter('');
    const r1 = await a.requestInsurancePlan({
      tenantId: 't-1',
      payerCode: 'pay@hcx',
      policyNumber: 'POL-1',
      providerId: 'HFR-1',
    });
    const r2 = await a.requestInsurancePlan({
      tenantId: 't-1',
      payerCode: 'pay@hcx',
      policyNumber: 'POL-1',
      providerId: 'HFR-1',
    });
    expect(r1.correlationId).not.toBe(r2.correlationId);
  });
});
