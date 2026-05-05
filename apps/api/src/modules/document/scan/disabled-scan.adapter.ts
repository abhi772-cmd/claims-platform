import { Injectable } from '@nestjs/common';

import {
  type ScanInput,
  type ScanResult,
  type VirusScanAdapter,
} from './virus-scan-adapter.interface';

// Bound when VIRUS_SCAN_MODE='off'. Every scan returns 'skipped' so the
// finalize path doesn't block. Discharge / claim-submit gates may
// optionally accept 'skipped' rows in dev environments — that's a
// product call, not an adapter call.
@Injectable()
export class DisabledScanAdapter implements VirusScanAdapter {
  async scan(_input: ScanInput): Promise<ScanResult> {
    return { status: 'skipped', engine: 'disabled' };
  }
}
