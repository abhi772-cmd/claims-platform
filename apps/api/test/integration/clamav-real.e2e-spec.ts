// Slice AU — real-clamd integration test. The unit suite at
// `clamav-scan.adapter.spec.ts` proves the adapter speaks INSTREAM
// correctly against a wire-format-faithful `node:net` mock; this
// suite proves the *same code* successfully talks to an actual
// clamd, picking up any drift between our reading of the protocol
// and clamd's behaviour (signature names, edge-case framing,
// version skew).
//
// We keep the surface tight: drive ClamAvScanAdapter directly with
// a stub ConfigService + a tiny StorageAdapter for the
// bucket/key path — no AppModule, no Postgres, no MinIO. The
// container is the only heavy dependency.

import { type ConfigService } from '@nestjs/config';

import { type AppConfig } from '../../src/config/configuration';
import { ClamAvScanAdapter } from '../../src/modules/document/scan/clamav-scan.adapter';
import { EICAR_TEST_STRING } from '../../src/modules/document/scan/stub-scan.adapter';
import {
  type GetObjectInput,
  type StorageAdapter,
} from '../../src/modules/storage/storage-adapter.interface';
import { startClamAv, type ClamAvHandles } from '../setup/clamav-container';

// 3 minutes is plenty for clamd to finish loading the signature DB +
// run the three scans. Hosted CI runners sometimes pull the image
// cold which itself can take ~60s.
jest.setTimeout(240_000);

function makeAdapter(endpoint: string, storage: StorageAdapter): ClamAvScanAdapter {
  const config = {
    get(key: string): string | null | undefined {
      if (key === 'VIRUS_SCAN_ENDPOINT') return endpoint;
      return undefined;
    },
  } as unknown as ConfigService<AppConfig, true>;
  return new ClamAvScanAdapter(config, storage);
}

const failingStorage: StorageAdapter = {
  presignUpload: async () => {
    throw new Error('not used in this suite');
  },
  finalize: async () => {
    throw new Error('not used in this suite');
  },
  getObject: async () => {
    throw new Error('storage.getObject should not be called when buffer is provided');
  },
};

describe('Slice AU — ClamAvScanAdapter against a real clamd', () => {
  let clam: ClamAvHandles;
  let adapter: ClamAvScanAdapter;

  beforeAll(async () => {
    clam = await startClamAv();
    adapter = makeAdapter(clam.endpoint, failingStorage);
  });

  afterAll(async () => {
    await clam?.shutdown();
  });

  it('clean buffer is clean against real clamd', async () => {
    const result = await adapter.scan({
      buffer: Buffer.from(
        'DigiSparsh discharge summary — patient OK, vitals stable.',
        'utf8',
      ),
    });
    expect(result).toEqual({ status: 'clean', engine: 'clamav' });
  });

  it('EICAR buffer is flagged with the canonical signature', async () => {
    const result = await adapter.scan({
      buffer: Buffer.from(EICAR_TEST_STRING, 'utf8'),
    });
    expect(result.status).toBe('infected');
    expect(result.engine).toBe('clamav');
    // Real ClamAV reports `Eicar-Signature` (older builds) or
    // `Win.Test.EICAR_HDB-1` (newer builds depending on the freshclam
    // DB shipped with the image). Both legitimately match — the
    // important contract is that infected status surfaces with a
    // non-empty signature.
    expect(result.signature).toBeTruthy();
    expect(result.signature?.length ?? 0).toBeGreaterThan(0);
  });

  it('S3-streaming path (Slice AS) routes through getObject and detects EICAR', async () => {
    let getObjectCall: GetObjectInput | null = null;
    const storage: StorageAdapter = {
      ...failingStorage,
      getObject: async (input) => {
        getObjectCall = input;
        return Buffer.from(EICAR_TEST_STRING, 'utf8');
      },
    };
    const a = makeAdapter(clam.endpoint, storage);
    const result = await a.scan({
      storageBucket: 'claims-prod',
      storageKey: 'tenant-1/claim-9/doc.pdf',
    });
    expect(result.status).toBe('infected');
    expect(result.engine).toBe('clamav');
    expect(getObjectCall).toEqual({
      storageBucket: 'claims-prod',
      storageKey: 'tenant-1/claim-9/doc.pdf',
    });
  });
});
