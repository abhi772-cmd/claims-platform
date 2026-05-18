import { isTransientNhcxError, mapNhcxError } from './nhcx-error-mapper';

describe('mapNhcxError', () => {
  it('maps canonical NHCX-* gateway codes', () => {
    const m = mapNhcxError('NHCX-107');
    expect(m.code).toBe('NHCX-107');
    expect(m.class).toBe('transient');
    expect(m.retriable).toBe(true);
    expect(m.hint).toMatch(/session token/i);
  });

  it('maps canonical PAYR-* PMJAY payer codes', () => {
    const m = mapNhcxError('PAYR-002');
    expect(m.code).toBe('PAYR-002');
    expect(m.class).toBe('permanent');
    expect(m.retriable).toBe(false);
    expect(m.hint).toMatch(/wallet exhausted/i);
  });

  it('maps canonical PreauthError- codes', () => {
    const m = mapNhcxError('PreauthError-001');
    expect(m.class).toBe('operator-action');
    expect(m.retriable).toBe(false);
  });

  it('handles unknown codes by surfacing the raw code on the hint', () => {
    const m = mapNhcxError('UNKNOWN-XYZ');
    expect(m.class).toBe('unknown');
    expect(m.hint).toContain('UNKNOWN-XYZ');
    expect(m.retriable).toBe(false);
  });

  it('handles whitespace tolerantly', () => {
    expect(mapNhcxError('  NHCX-107  ').class).toBe('transient');
  });
});

describe('P4.28 typo tolerance', () => {
  it('normalises NHCX_101 → NHCX-101', () => {
    expect(mapNhcxError('NHCX_101').code).toBe('NHCX-101');
  });

  it('normalises PAYR_002 → PAYR-002', () => {
    expect(mapNhcxError('PAYR_002').code).toBe('PAYR-002');
  });

  it('normalises PreauthError001 → PreauthError-001', () => {
    expect(mapNhcxError('PreauthError001').code).toBe('PreauthError-001');
  });

  it('normalises both spellings of the intimationNumber typo', () => {
    expect(mapNhcxError('INITIMATIONNUMBER-MISSING').code).toBe('NHCX-109');
    expect(mapNhcxError('INTIMATIONNUMBER-MISSING').code).toBe('NHCX-109');
  });
});

describe('isTransientNhcxError', () => {
  it('returns true for NHCX-* transient codes', () => {
    expect(isTransientNhcxError('NHCX-101')).toBe(true);
    expect(isTransientNhcxError('NHCX-103')).toBe(true);
  });

  it('returns false for permanent + operator-action codes', () => {
    expect(isTransientNhcxError('PAYR-001')).toBe(false);
    expect(isTransientNhcxError('PreauthError-001')).toBe(false);
  });

  it('returns false for unknown codes (do not retry mystery errors)', () => {
    expect(isTransientNhcxError('SOMETHING-NEW')).toBe(false);
  });
});
