// Slice AV — unit coverage for the stub EOB-OCR adapter.

import { DisabledEobOcrAdapter } from './disabled-eob-ocr.adapter';
import { STUB_EOB_SENTINELS, StubEobOcrAdapter } from './stub-eob-ocr.adapter';

describe('DisabledEobOcrAdapter', () => {
  it("returns 'skipped' regardless of input", async () => {
    const adapter = new DisabledEobOcrAdapter();
    const r1 = await adapter.extract({ buffer: Buffer.from('anything') });
    expect(r1).toEqual({ status: 'skipped', engine: 'disabled' });
    const r2 = await adapter.extract({ storageBucket: 'b', storageKey: 'k' });
    expect(r2).toEqual({ status: 'skipped', engine: 'disabled' });
  });
});

describe('StubEobOcrAdapter', () => {
  let adapter: StubEobOcrAdapter;

  beforeEach(() => {
    adapter = new StubEobOcrAdapter();
  });

  it('clean sentinel → status=extracted with refnum, full receivedAmount, no deductions', async () => {
    const buf = Buffer.from(
      `Lorem ipsum...\n${STUB_EOB_SENTINELS.clean('STUB-CL-12345', 100_000)}\nfooter`,
    );
    const result = await adapter.extract({ buffer: buf });
    expect(result.status).toBe('extracted');
    expect(result.engine).toBe('stub');
    expect(result.fields).toBeDefined();
    expect(result.fields!.claimRefNum).toBe('STUB-CL-12345');
    expect(result.fields!.receivedAmount).toBe(100_000);
    expect(result.fields!.deductionAmount).toBe(0);
    expect(result.fields!.deductions).toEqual([]);
    expect(result.fields!.shortPaymentReasons).toEqual([]);
    expect(result.fields!.confidence?.claimRefNum).toBe(1);
  });

  it('short sentinel → status=extracted with deductionAmount + a single deduction line', async () => {
    const buf = Buffer.from(STUB_EOB_SENTINELS.short('STUB-CL-67890', 75_000, 100_000));
    const result = await adapter.extract({ buffer: buf });
    expect(result.status).toBe('extracted');
    expect(result.fields!.claimRefNum).toBe('STUB-CL-67890');
    expect(result.fields!.receivedAmount).toBe(75_000);
    expect(result.fields!.deductionAmount).toBe(25_000);
    expect(result.fields!.deductions).toEqual([
      {
        category: 'cap_exceeded',
        amount: 25_000,
        reason: 'Cap exceeded under rider B',
      },
    ]);
    expect(result.fields!.shortPaymentReasons).toEqual(['Cap exceeded under rider B']);
  });

  it('fail sentinel → status=failed with stub error message', async () => {
    const buf = Buffer.from(STUB_EOB_SENTINELS.fail);
    const result = await adapter.extract({ buffer: buf });
    expect(result.status).toBe('failed');
    expect(result.engine).toBe('stub');
    expect(result.error).toMatch(/Stub-injected/);
  });

  it('unrecognised content → status=low_confidence with empty fields', async () => {
    const buf = Buffer.from('A real EOB PDF that the stub does not recognise.');
    const result = await adapter.extract({ buffer: buf });
    expect(result.status).toBe('low_confidence');
    expect(result.engine).toBe('stub');
    expect(result.fields).toEqual({ deductions: [], shortPaymentReasons: [] });
  });

  it('no buffer (only bucket+key) → status=skipped (real adapter handles S3)', async () => {
    const result = await adapter.extract({ storageBucket: 'b', storageKey: 'k' });
    expect(result.status).toBe('skipped');
    expect(result.engine).toBe('stub');
  });

  it('clean sentinel ignores surrounding noise — anchors on the prefix not the whole buffer', async () => {
    const noisyBuf = Buffer.from(
      `<<<unrelated header>>>\n${STUB_EOB_SENTINELS.clean('REF-A1', 50_000)}\n<<<more noise>>>`,
    );
    const result = await adapter.extract({ buffer: noisyBuf });
    expect(result.status).toBe('extracted');
    expect(result.fields!.claimRefNum).toBe('REF-A1');
    expect(result.fields!.receivedAmount).toBe(50_000);
  });

  it('STUB_EOB_SENTINELS produce strings the adapter can round-trip', () => {
    // Documents the contract authors of integration fixtures need.
    expect(STUB_EOB_SENTINELS.clean('REF-1', 100)).toBe('STUB-EOB-CLEAN-REF-1-100');
    expect(STUB_EOB_SENTINELS.short('REF-1', 80, 100)).toBe('STUB-EOB-SHORT-REF-1-80-100');
    expect(STUB_EOB_SENTINELS.fail).toBe('STUB-EOB-FAIL');
  });
});
