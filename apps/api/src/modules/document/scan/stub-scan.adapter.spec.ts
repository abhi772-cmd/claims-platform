import { DisabledScanAdapter } from './disabled-scan.adapter';
import { EICAR_TEST_STRING, StubScanAdapter } from './stub-scan.adapter';

describe('StubScanAdapter', () => {
  const adapter = new StubScanAdapter();

  it('returns clean for benign content', async () => {
    const r = await adapter.scan({ buffer: Buffer.from('Hello world. PDF body bytes.') });
    expect(r.status).toBe('clean');
    expect(r.engine).toBe('stub');
  });

  it('detects EICAR signature in the buffer', async () => {
    const r = await adapter.scan({ buffer: Buffer.from(EICAR_TEST_STRING) });
    expect(r.status).toBe('infected');
    expect(r.signature).toBe('Eicar-Test-Signature');
  });

  it('detects EICAR even when wrapped in larger content', async () => {
    const wrapped = Buffer.concat([
      Buffer.from('preamble bytes...\n'),
      Buffer.from(EICAR_TEST_STRING),
      Buffer.from('\n...trailing bytes'),
    ]);
    const r = await adapter.scan({ buffer: wrapped });
    expect(r.status).toBe('infected');
  });

  it('returns clean (not infected) when no buffer is provided', async () => {
    const r = await adapter.scan({ storageBucket: 'b', storageKey: 'k' });
    expect(r.status).toBe('clean');
  });
});

describe('DisabledScanAdapter', () => {
  const adapter = new DisabledScanAdapter();

  it('always returns skipped regardless of input', async () => {
    expect((await adapter.scan({ buffer: Buffer.from(EICAR_TEST_STRING) })).status).toBe('skipped');
    expect((await adapter.scan({})).status).toBe('skipped');
  });
});
