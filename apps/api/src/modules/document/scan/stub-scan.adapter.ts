import { Injectable } from '@nestjs/common';

import {
  type ScanInput,
  type ScanResult,
  type VirusScanAdapter,
} from './virus-scan-adapter.interface';

// EICAR Standard Anti-Virus Test File. Universal AV test signature —
// every legit scanner detects it. We hard-code it here so CI can
// verify the infected-path without shipping a real virus.
const EICAR =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

// Bound when VIRUS_SCAN_MODE='stub'. Detects EICAR (the universal AV
// test signature) and treats anything else as clean. Used by the
// integration tests so we can prove the infected-path end-to-end
// without needing ClamAV running in CI.
@Injectable()
export class StubScanAdapter implements VirusScanAdapter {
  async scan(input: ScanInput): Promise<ScanResult> {
    if (!input.buffer) {
      // The real ClamAV adapter would stream from S3 by (bucket,key);
      // the stub only knows what's in memory. With no buffer we can't
      // assert anything, so default to clean — tests that want to
      // exercise infected pass an explicit buffer.
      return { status: 'clean', engine: 'stub' };
    }
    const text = input.buffer.toString('utf8');
    if (text.includes(EICAR)) {
      return {
        status: 'infected',
        engine: 'stub',
        signature: 'Eicar-Test-Signature',
      };
    }
    return { status: 'clean', engine: 'stub' };
  }
}

export const EICAR_TEST_STRING = EICAR;
