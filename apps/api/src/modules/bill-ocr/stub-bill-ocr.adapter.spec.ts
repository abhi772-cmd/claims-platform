import { StubBillOcrAdapter, STUB_BILL_SENTINELS } from './stub-bill-ocr.adapter';

describe('StubBillOcrAdapter', () => {
  const adapter = new StubBillOcrAdapter();

  it('returns fixture lines for the clean sentinel', async () => {
    const result = await adapter.extractBill({
      buffer: Buffer.from(STUB_BILL_SENTINELS.clean),
    });
    expect(result.status).toBe('extracted');
    expect(result.engine).toBe('stub');
    expect(result.lines.length).toBeGreaterThan(0);
    const surgery = result.lines.find((l) => l.description === 'Surgery');
    expect(surgery?.amountPaise).toBe(4500000);
    // Includes non-medical rows so the downstream classifier has
    // something to strip.
    expect(result.lines.some((l) => l.description === 'TV rental')).toBe(true);
  });

  it('returns failed for the fail sentinel', async () => {
    const result = await adapter.extractBill({
      buffer: Buffer.from(STUB_BILL_SENTINELS.fail),
    });
    expect(result.status).toBe('failed');
    expect(result.lines).toEqual([]);
    expect(result.error).toMatch(/failure/i);
  });

  it('returns low_confidence with no lines for unrecognised input', async () => {
    const result = await adapter.extractBill({
      buffer: Buffer.from('a random bill with no sentinel'),
    });
    expect(result.status).toBe('low_confidence');
    expect(result.lines).toEqual([]);
  });
});
