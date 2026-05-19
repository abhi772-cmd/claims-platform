import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import {
  type AbhaCreationAdapter,
  type AbhaInitInput,
  type AbhaVerifyInput,
} from './abha-creation-adapter.interface';
import {
  type AbhaCreateInitResponse,
  type AbhaCreateVerifyResponse,
} from '@claims/contracts';

// Deterministic stub for dev / CI / demo. Three behaviours keyed on the
// Aadhaar prefix:
//
//   * Aadhaar starts with `000000` → init rejects (simulates an
//     ABDM-side "no mobile linked to this Aadhaar" rejection)
//   * Aadhaar starts with `999999` → init succeeds but verify always
//     returns OTP_MISMATCH (lets the demo exercise the wrong-OTP path)
//   * any other 12-digit Aadhaar → init returns a deterministic txnId;
//     verify succeeds with OTP `123456` and returns a fresh ABHA
//     derived from the Aadhaar suffix
//
// The in-memory txnId map below threads init → verify so a verify with
// a stale or made-up txnId is rejected the same way the real ABDM
// rejects it.

interface TxnState {
  aadhaar: string;
  createdAt: number;
}

const TXN_TTL_MS = 10 * 60_000; // ABDM v3 OTPs are valid for 10 minutes

@Injectable()
export class StubAbhaCreationAdapter implements AbhaCreationAdapter {
  private readonly log = new Logger(StubAbhaCreationAdapter.name);
  private readonly txns = new Map<string, TxnState>();

  async init(input: AbhaInitInput): Promise<AbhaCreateInitResponse> {
    this.gc();
    if (input.aadhaar.startsWith('000000')) {
      throw new Error(
        'ABDM stub: no mobile linked to this Aadhaar (Aadhaar prefix 000000 simulates this rejection).',
      );
    }
    const txnId = `stub-txn-${randomUUID()}`;
    this.txns.set(txnId, { aadhaar: input.aadhaar, createdAt: Date.now() });
    this.log.log(`ABHA init stub tenantId=${input.tenantId} txnId=${txnId}`);
    return {
      txnId,
      mobileMasked: `XXXXXX${input.aadhaar.slice(-4)}`,
      fullNameHint: 'Stub Patient',
    };
  }

  async verify(input: AbhaVerifyInput): Promise<AbhaCreateVerifyResponse> {
    this.gc();
    const txn = this.txns.get(input.txnId);
    if (!txn) {
      throw new Error(
        'ABDM stub: txnId not found or expired. Re-run init.',
      );
    }
    if (txn.aadhaar.startsWith('999999')) {
      throw new Error(
        'ABDM stub: OTP mismatch (Aadhaar prefix 999999 simulates this).',
      );
    }
    if (input.otp !== '123456') {
      throw new Error('ABDM stub: OTP mismatch. The demo OTP is 123456.');
    }
    this.txns.delete(input.txnId);
    // Build a synthetic ABHA from the Aadhaar suffix so the same
    // Aadhaar always yields the same ABHA across re-runs. Format:
    // 14004XXXXXXXXX where the trailing 9 chars are derived.
    const suffix = txn.aadhaar.slice(3, 12); // 9 chars
    const abhaNumber = `14004${suffix}`;
    return {
      abhaNumber,
      healthIdNumber: `stub.patient.${suffix}@abdm`,
      fullName: 'Stub Patient',
      gender: 'F',
      dateOfBirth: '1985-06-15',
    };
  }

  private gc(): void {
    const cutoff = Date.now() - TXN_TTL_MS;
    for (const [id, state] of this.txns.entries()) {
      if (state.createdAt < cutoff) this.txns.delete(id);
    }
  }
}
