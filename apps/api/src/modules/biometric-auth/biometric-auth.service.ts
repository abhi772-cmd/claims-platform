// Slice BG — case-scoped wrapper around the BiometricAuthAdapter.
//
// Three responsibilities:
//   1. Proxy the adapter's init / verify dance over our public
//      `/cases/:caseId/biometric-auth/{init,verify}` endpoints.
//      Per-tenant context is enforced via prisma.runInTenantContext
//      so the verification rows respect RLS.
//   2. Persist a `biometric_verification` row on every successful
//      verify so the gate (#3) has something to check. We store
//      enough audit metadata to correlate to ABDM logs (txnId,
//      authMode, hashed loginId) but NOT the raw loginId or the
//      ABHA token — the token wiring lands in a follow-up slice.
//   3. Expose `assertVerifiedFor(caseId, process)` — the gate
//      helper that PreauthService.submit (process='Preauth') and
//      ClaimSubmitService.submit (process='Discharge') call when
//      tenant.pmjayMode === 'on'.

import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  BIOMETRIC_AUTH_ADAPTER,
  type BiometricAuthAdapter,
  type BiometricAuthMode,
  type BiometricAuthScope,
  type BiometricLoginHint,
  type BiometricProcess,
} from './biometric-auth-adapter.interface';
import {
  BiometricVerificationFailedError,
  BiometricVerificationRequiredError,
} from '../../common/errors/biometric-errors';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { type AppConfig } from '../../config/configuration';

export interface InitiateBiometricInput {
  tenantId: string;
  caseId: string;
  scope: BiometricAuthScope;
  loginHint: BiometricLoginHint;
  loginId: string;
  authMode: BiometricAuthMode;
  process: BiometricProcess;
  // Optional overrides — normally resolved server-side from the case's
  // payer (payerId) and the ABDM session flow (bearerToken). Operators
  // never supply these.
  payerId?: string;
  bearerToken?: string;
}

export interface InitiateBiometricResult {
  status: 'init_ok' | 'disabled';
  txnId?: string;
}

export interface VerifyBiometricInput {
  tenantId: string;
  caseId: string;
  scope: BiometricAuthScope;
  authMode: BiometricAuthMode;
  loginHint: BiometricLoginHint;
  loginId: string;
  authData: {
    txnId: string;
    fingerPrintAuthPid?: string;
    faceAuthPid?: string;
    irisAuthPid?: string;
  };
  process: BiometricProcess;
  // Optional overrides — see InitiateBiometricInput.
  payerId?: string;
  bearerToken?: string;
}

export interface VerifyBiometricResult {
  status: 'verified' | 'disabled';
  verificationId?: string;
  verifiedAt?: string;
  expiresAt?: string;
}

@Injectable()
export class BiometricAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(BIOMETRIC_AUTH_ADAPTER) private readonly adapter: BiometricAuthAdapter,
  ) {}

  async initiate(input: InitiateBiometricInput): Promise<InitiateBiometricResult> {
    const payerId = await this.resolvePayerCode(input.tenantId, input.caseId, input.payerId);
    const result = await this.adapter.init({
      scope: input.scope,
      loginHint: input.loginHint,
      loginId: input.loginId,
      authMode: input.authMode,
      process: input.process,
      payerId,
      bearerToken: this.resolveBearerToken(input.bearerToken),
    });
    if (result.status === 'disabled') return { status: 'disabled' };
    if (result.status === 'failed') {
      throw new BiometricVerificationFailedError(result.error ?? 'Adapter failed on init');
    }
    if (!result.txnId) {
      throw new BiometricVerificationFailedError('Adapter did not return a txnId');
    }
    return { status: 'init_ok', txnId: result.txnId };
  }

  async verify(input: VerifyBiometricInput): Promise<VerifyBiometricResult> {
    const payerId = await this.resolvePayerCode(input.tenantId, input.caseId, input.payerId);
    const adapterResult = await this.adapter.verify({
      scope: input.scope,
      authMode: input.authMode,
      authData: input.authData,
      process: input.process,
      payerId,
      bearerToken: this.resolveBearerToken(input.bearerToken),
    });
    if (adapterResult.status === 'disabled') return { status: 'disabled' };
    if (adapterResult.status === 'failed') {
      throw new BiometricVerificationFailedError(adapterResult.error ?? 'Adapter failed on verify');
    }

    const ttlMin = this.config.get('BIOMETRIC_VERIFICATION_TTL_MINUTES', { infer: true });
    const verifiedAt = new Date();
    const expiresAt = new Date(verifiedAt.getTime() + ttlMin * 60_000);
    const loginIdHash = createHash('sha256').update(input.loginId).digest('hex');

    const row = await this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      return tx.biometricVerification.create({
        data: {
          tenantId: input.tenantId,
          caseId: input.caseId,
          process: input.process,
          authMode: input.authMode,
          loginHint: input.loginHint,
          loginIdHash,
          abdmTxnId: input.authData.txnId,
          verifiedAt,
          expiresAt,
        },
      });
    });

    return {
      status: 'verified',
      verificationId: row.id,
      verifiedAt: verifiedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  // Gate helper. Called from PreauthService.submit + ClaimSubmitService.submit
  // when tenant.pmjayMode === 'on'. Throws BiometricVerificationRequiredError
  // (HTTP 412) when no non-expired verification exists for the given
  // (caseId, process). The error code maps to a frontend modal that
  // bounces the operator to the biometric capture flow and retries.
  async assertVerifiedFor(
    tenantId: string,
    caseId: string,
    process: BiometricProcess,
  ): Promise<void> {
    const row = await this.prisma.runInTenantContext(tenantId, 'tenant', (tx) =>
      tx.biometricVerification.findFirst({
        where: {
          tenantId,
          caseId,
          process,
          expiresAt: { gt: new Date() },
        },
        orderBy: { verifiedAt: 'desc' },
      }),
    );
    if (!row) {
      throw new BiometricVerificationRequiredError(
        `PMJAY case requires a recent ${process} biometric verification on case ${caseId}.`,
      );
    }
  }

  // Resolve the NHCX recipient (payer) participant code from the case
  // itself so the operator never has to know or type it. The chain is
  // case → its claim → claim.payerCode (stable Payer.code) →
  // payer.hcxCode (the NHCX participant id, e.g. 'pmjay@hcx').
  //
  // An explicit override (`provided`) wins — useful for tooling /
  // tests — but the normal path resolves server-side. Also validates
  // the case is on this tenant (replaces the old assertCaseOnTenant).
  private async resolvePayerCode(
    tenantId: string,
    caseId: string,
    provided?: string,
  ): Promise<string> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const found = await tx.case.findUnique({
        where: { id: caseId },
        select: { id: true },
      });
      if (!found) {
        throw new ValidationFailedError({ caseId: ['Case not found.'] });
      }
      if (provided) return provided;

      // Newest claim on the case carries the payerCode captured at
      // eligibility time. PMJAY cases always have one by the time the
      // biometric gate runs (it's an admission-time step after the
      // case + claim are created).
      const claim = await tx.claim.findFirst({
        where: { caseId },
        orderBy: { initiatedAt: 'desc' },
        select: { payerCode: true },
      });
      if (!claim?.payerCode) {
        throw new ValidationFailedError({
          payerId: [
            'No payer is set on this case yet — run eligibility first so the payer is known.',
          ],
        });
      }
      const payer = await tx.payer.findUnique({
        where: { code: claim.payerCode },
        select: { hcxCode: true, name: true },
      });
      if (!payer?.hcxCode) {
        throw new ValidationFailedError({
          payerId: [
            `Payer "${claim.payerCode}" has no NHCX participant code registered. ` +
              `Add it on the payer master before biometric verification.`,
          ],
        });
      }
      return payer.hcxCode;
    });
  }

  // ABDM consent bearer token. In stub/off modes the adapter ignores
  // it, so a placeholder is fine. In real mode this is where the ABDM
  // session/consent service plugs in to mint a scoped token — deferred
  // (see the BIS productionization plan). Operators never paste a JWT.
  private resolveBearerToken(provided?: string): string {
    if (provided) return provided;
    const mode = this.config.get('BIOMETRIC_AUTH_MODE', { infer: true });
    if (mode === 'real') {
      // Hard signal during productionization: real mode must not run
      // with a placeholder token. The ABDM session service will fill
      // this in; until then, fail loudly rather than send garbage.
      throw new ValidationFailedError({
        bearerToken: [
          'ABDM consent token is required in real mode but the session flow is not wired yet.',
        ],
      });
    }
    return 'stub-bearer-token';
  }
}
