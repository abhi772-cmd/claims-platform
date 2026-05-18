import {
  buildJwePayloadEnvelope,
  buildNhcxProtocolHeader,
  isProtocolError,
  isProtocolPayload,
  nhcxIstIso,
  workflowIdFor,
  HEADER_API_CALL_ID,
  HEADER_CORRELATION_ID,
  HEADER_ENTITY_TYPE,
  HEADER_RECIPIENT_CODE,
  HEADER_SENDER_CODE,
  HEADER_STATUS,
  HEADER_TIMESTAMP,
  HEADER_WORKFLOW_ID,
} from './nhcx-protocol';

describe('NHCX protocol envelope helpers', () => {
  it('buildNhcxProtocolHeader emits all 8 mandatory fields with underscore names', () => {
    const h = buildNhcxProtocolHeader({
      senderCode: 'hospital@nhcx',
      recipientCode: 'payer@nhcx',
      correlationId: 'corr-123',
      operation: 'claim/submit',
    });
    expect(h[HEADER_SENDER_CODE]).toBe('hospital@nhcx');
    expect(h[HEADER_RECIPIENT_CODE]).toBe('payer@nhcx');
    expect(h[HEADER_CORRELATION_ID]).toBe('corr-123');
    expect(h[HEADER_API_CALL_ID]).toMatch(/^[0-9a-f-]{36}$/);
    expect(h[HEADER_TIMESTAMP]).toMatch(/^\d+$/);
    expect(h[HEADER_WORKFLOW_ID]).toBe('15');
    expect(h[HEADER_ENTITY_TYPE]).toBe('Bundle');
    expect(h[HEADER_STATUS]).toBe('request.queued');
  });

  it('workflowIdFor maps the documented operations to their HCX 0.7.1 IDs', () => {
    expect(workflowIdFor('coverage-eligibility/check')).toBe('12');
    expect(workflowIdFor('coverage-eligibility/check/discovery')).toBe('121');
    expect(workflowIdFor('preauth/submit')).toBe('13');
    expect(workflowIdFor('preauth/query/respond')).toBe('14');
    expect(workflowIdFor('preauth/enhance')).toBe('32');
    expect(workflowIdFor('claim/submit')).toBe('15');
    expect(workflowIdFor('claim/reprocess')).toBe('151');
    expect(workflowIdFor('discharge/submit')).toBe('16');
    expect(workflowIdFor('task/submit')).toBe('18');
    expect(workflowIdFor('payment-notice/notify')).toBe('19');
    expect(workflowIdFor('payment-reconciliation')).toBe('20');
    expect(workflowIdFor('insurance-plan/search')).toBe('21');
    expect(workflowIdFor('participant/get/policies')).toBe('23');
    expect(workflowIdFor('paymentack')).toBe('30');
  });

  it('workflowIdFor returns 0 for unknown operations so misconfig is visible in logs', () => {
    expect(workflowIdFor('totally/unknown')).toBe('0');
  });

  it('buildJwePayloadEnvelope wraps the compact JWE in `{ payload: ... }`', () => {
    expect(buildJwePayloadEnvelope('eyJhbGciOi...')).toEqual({ payload: 'eyJhbGciOi...' });
  });

  it('isProtocolError discriminates against payload-shaped bodies', () => {
    expect(isProtocolError({ error: { code: 'X', message: 'y' } })).toBe(true);
    expect(isProtocolError({ payload: 'jwe' })).toBe(false);
    expect(isProtocolError({})).toBe(false);
    expect(isProtocolError(null)).toBe(false);
  });

  it('isProtocolPayload discriminates against error-shaped bodies', () => {
    expect(isProtocolPayload({ payload: 'jwe' })).toBe(true);
    expect(isProtocolPayload({ error: { code: 'X', message: 'y' } })).toBe(false);
    expect(isProtocolPayload({})).toBe(false);
  });

  it('nhcxIstIso emits +05:30 offset with no DST', () => {
    // 2026-05-01T10:00:00Z → 2026-05-01T15:30:00+05:30
    const iso = nhcxIstIso(new Date('2026-05-01T10:00:00.000Z'));
    expect(iso).toBe('2026-05-01T15:30:00+05:30');
  });

  it('nhcxIstIso handles day rollover at the IST boundary', () => {
    // 2026-05-01T20:00:00Z → 2026-05-02T01:30:00+05:30
    const iso = nhcxIstIso(new Date('2026-05-01T20:00:00.000Z'));
    expect(iso).toBe('2026-05-02T01:30:00+05:30');
  });

  it('buildNhcxProtocolHeader emits debug_flag only when set to Error or Info', () => {
    const off = buildNhcxProtocolHeader({
      senderCode: 's',
      recipientCode: 'r',
      correlationId: 'c',
      operation: 'claim/submit',
      debugFlag: 'Off',
    });
    expect(off['x-hcx-debug_flag']).toBeUndefined();
    const on = buildNhcxProtocolHeader({
      senderCode: 's',
      recipientCode: 'r',
      correlationId: 'c',
      operation: 'claim/submit',
      debugFlag: 'Error',
    });
    expect(on['x-hcx-debug_flag']).toBe('Error');
  });
});
