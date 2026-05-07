import { type ConfigService } from '@nestjs/config';

import { StubStorageAdapter } from './stub-storage.adapter';

const cfg = (): ConfigService => ({ get: () => undefined }) as unknown as ConfigService;

describe('StubStorageAdapter', () => {
  let adapter: StubStorageAdapter;

  beforeEach(() => {
    adapter = new StubStorageAdapter(cfg() as never);
  });

  it('presignUpload synthesises a key under tenant/claim/doc and returns stub URL', async () => {
    const out = await adapter.presignUpload({
      tenantId: 'tenant-1',
      claimId: 'claim-9',
      documentId: 'doc-42',
      contentType: 'application/pdf',
      declaredSizeBytes: 1024,
      originalFilename: 'discharge.pdf',
    });
    expect(out.storageBucket).toBe('claims-stub');
    expect(out.storageKey).toBe('tenant-1/claim-9/doc-42-discharge.pdf');
    expect(out.uploadUrl.startsWith('stub://')).toBe(true);
    expect(out.requiredHeaders['content-type']).toBe('application/pdf');
    expect(new Date(out.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('finalize fabricates an etag derived from the storage key suffix', async () => {
    const out = await adapter.finalize({
      storageBucket: 'claims-stub',
      storageKey: 'tenant-1/claim-9/doc-42-discharge.pdf',
    });
    expect(out.etag).toMatch(/^stub-etag-/);
    // Stub mode trusts the declared size; finalize reports 0 so the
    // service falls back to the size recorded at init.
    expect(out.actualSizeBytes).toBe(0);
  });

  it('Slice AS — getObject throws (stub mode has no real bytes to fetch)', async () => {
    await expect(
      adapter.getObject({
        storageBucket: 'claims-stub',
        storageKey: 'tenant-1/claim-9/doc-42-discharge.pdf',
      }),
    ).rejects.toThrow(/STORAGE_MODE=real/);
  });
});
