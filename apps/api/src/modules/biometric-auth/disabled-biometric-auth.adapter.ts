// Slice BF — Disabled biometric auth adapter. Bound when
// BIOMETRIC_AUTH_MODE='off' (the default). Non-PMJAY tenants and
// dev / test deployments take this path so the rest of the platform
// doesn't pay the ABDM integration tax.
//
// The status='disabled' contract is part of the adapter spec — Slice
// BG's gate logic treats it the same as a non-applicable check
// (PMJAY-only flag off → skip the verify). Tenants whose configuration
// asks for biometric while the platform is in off mode get a clear
// fail at the gate, not a silent bypass.

import { Injectable } from '@nestjs/common';

import {
  type BiometricAuthAdapter,
  type BiometricInitResult,
  type BiometricRefreshResult,
  type BiometricVerifyResult,
} from './biometric-auth-adapter.interface';

@Injectable()
export class DisabledBiometricAuthAdapter implements BiometricAuthAdapter {
  async init(): Promise<BiometricInitResult> {
    return { status: 'disabled' };
  }
  async verify(): Promise<BiometricVerifyResult> {
    return { status: 'disabled' };
  }
  async refreshToken(): Promise<BiometricRefreshResult> {
    return { status: 'disabled' };
  }
}
