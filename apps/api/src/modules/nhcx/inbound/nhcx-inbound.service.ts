import {
  type NhcxInboundOperation,
  type NhcxInboundRequest,
} from '@claims/contracts';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  parseClaimResponse,
  parseCommunication,
  parseEligibilityResponse,
  parsePreauthResponse,
} from './fhir-response-parsers';
import { NhcxSenderAllowlistService } from './nhcx-sender-allowlist.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { type AppConfig } from '../../../config/configuration';
import { ClaimSubmitService } from '../../claim-submit/claim-submit.service';
import { DischargeService } from '../../discharge/discharge.service';
import { EligibilityService } from '../../eligibility/eligibility.service';
import { PreauthService } from '../../preauth/preauth.service';
import {
  NHCX_KEY_RESOLVER,
  type NhcxKeyResolver,
} from '../nhcx-key-resolver';
import { decryptFromParticipant, readJweKid } from '../nhcx.crypto';

export interface InboundDispatchInput {
  // HTTP-level metadata captured by the controller. correlationId
  // and operation come from the gateway's `x-hcx-*` headers.
  correlationId: string;
  operation: NhcxInboundOperation;
  senderCode: string | null;
  body: NhcxInboundRequest;
  receivedAt: Date;
}

export interface InboundDispatchResult {
  // The integration_message row id we wrote synchronously. Returned
  // so the controller can echo it back if needed.
  inboundMessageId: string;
  // 'accepted'        = persisted + scheduled.
  // 'duplicate'       = already had a row for this correlationId
  //                     (idempotency guard fired).
  // 'invalid'         = no matching outbound row; misrouted callback.
  // 'rejected_sender' = the x-hcx-sender-code is not in the payer
  //                     allowlist (Slice AG). Controller still
  //                     returns 200 to the gateway (NHA shouldn't
  //                     retry on a configuration mismatch), but no
  //                     row is written.
  outcome: 'accepted' | 'duplicate' | 'invalid' | 'rejected_sender';
}

// Slice Z core. Two responsibilities:
//   1. SYNCHRONOUS — persist the raw inbound row and let the controller
//      return 200 immediately. Idempotency is enforced here: a duplicate
//      correlationId on the inbound side surfaces as 'duplicate'.
//   2. ASYNC — decrypt the JWE, parse the FHIR Bundle, dispatch to the
//      right service.applyDecision-equivalent. Failures flip the
//      integration_message row to 'failed' with failureClass set;
//      they never propagate back to the controller.
//
// We deliberately keep "async" inside the same Node process for V1
// rather than enqueuing on a job queue we don't have. The spec calls
// for full decoupling at production volume; we'll wrap that in
// Sprint 5 hardening once volume is real.
@Injectable()
export class NhcxInboundService {
  private readonly log = new Logger(NhcxInboundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibility: EligibilityService,
    private readonly preauth: PreauthService,
    private readonly claimSubmit: ClaimSubmitService,
    private readonly discharge: DischargeService,
    private readonly senderAllowlist: NhcxSenderAllowlistService,
    private readonly config: ConfigService<AppConfig, true>,
    @Optional() @Inject(NHCX_KEY_RESOLVER) private readonly keyResolver: NhcxKeyResolver | null,
  ) {}

  // Step 1 — synchronous. The controller must complete this and reply
  // 200 within the gateway's timeout (typically 5s). We do exactly two
  // things here: idempotency check + persist.
  //
  // Both reads + the create run as platform_admin because we don't yet
  // know the tenantId (it's resolved from the matching outbound row).
  // integration_message has FORCE ROW LEVEL SECURITY, so a bare query
  // outside any tenant context returns zero rows.
  async receive(
    input: InboundDispatchInput,
  ): Promise<InboundDispatchResult> {
    // Slice AG: drop the request before we even touch Postgres if
    // the sender code isn't in the payer allowlist. The webhook is
    // public; this is the cheap defense-in-depth gate that catches
    // misrouted callbacks (and bad-faith senders) before they get to
    // touch the integration_message ledger.
    if (!(await this.senderAllowlist.isAllowed(input.senderCode))) {
      return { inboundMessageId: '', outcome: 'rejected_sender' };
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.role', 'platform_admin', true)`;

      // Idempotency: NHA may retry on transient failures. A repeat
      // correlationId+operation on the inbound side is benign — log + skip.
      // We also filter on operation because the Slice K orchestrator
      // writes a synthetic inbound row for stub-mode responses (operation
      // = the outbound op like 'eligibility.verify'). The gateway-callback
      // inbound uses an HCX operation name like 'coverageeligibility/on_check',
      // so the two never collide.
      const existing = await tx.integrationMessage.findFirst({
        where: {
          correlationId: input.correlationId,
          direction: 'inbound',
          integration: 'nhcx',
          operation: input.operation,
        },
        select: { id: true, tenantId: true, status: true },
      });
      if (existing) {
        this.log.log(
          `nhcx inbound duplicate correlationId=${input.correlationId} existingId=${existing.id} status=${existing.status}`,
        );
        return { inboundMessageId: existing.id, outcome: 'duplicate' as const };
      }

      // Find the matching outbound row to learn which tenant + claim
      // this callback belongs to. Without it we have no tenant context
      // to write the inbound row under. If no outbound exists this is
      // either a misrouted callback or a bundle we never sent.
      const outbound = await tx.integrationMessage.findFirst({
        where: {
          correlationId: input.correlationId,
          direction: 'outbound',
          integration: 'nhcx',
        },
        select: { id: true, tenantId: true, claimId: true, operation: true },
      });
      if (!outbound) {
        this.log.warn(
          `nhcx inbound has no matching outbound correlationId=${input.correlationId} operation=${input.operation}`,
        );
        return { inboundMessageId: '', outcome: 'invalid' as const };
      }

      // Persist the inbound row. Still inside the platform_admin tx so
      // the INSERT WITH CHECK passes (the policy allows
      // platform_admin OR tenantId-match).
      const inboundRow = await tx.integrationMessage.create({
        data: {
          tenantId: outbound.tenantId,
          ...(outbound.claimId !== null ? { claimId: outbound.claimId } : {}),
          direction: 'inbound',
          integration: 'nhcx',
          operation: input.operation,
          correlationId: input.correlationId,
          status: 'pending',
          rawRequest: input.body as never,
        },
        select: { id: true },
      });
      return { inboundMessageId: inboundRow.id, outcome: 'accepted' as const };
    });
  }

  // Step 2 — async-ish. Called immediately after receive() from the
  // controller without awaiting. Failures are caught and recorded on
  // the row; nothing here propagates to the caller.
  async process(
    inboundMessageId: string,
    input: InboundDispatchInput,
  ): Promise<void> {
    try {
      await this.processInternal(inboundMessageId, input);
    } catch (err) {
      // err.constructor.name reports the actual JS class
      // (e.g. InvalidClaimTransitionError); err.name is just whatever
      // the parent class declared (DomainError, Error). We want the
      // most-specific name for failure classification.
      const errorName =
        err instanceof Error
          ? (err.constructor.name === 'Error' ? err.name : err.constructor.name)
          : 'Error';
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(
        `nhcx inbound processing failed correlationId=${input.correlationId} err=${errorName}: ${message}`,
      );
      await this.markFailed(inboundMessageId, errorName, message);
    }
  }

  private async processInternal(
    inboundMessageId: string,
    input: InboundDispatchInput,
  ): Promise<void> {
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.role', 'platform_admin', true)`;
      return tx.integrationMessage.findUnique({
        where: { id: inboundMessageId },
        select: { tenantId: true, claimId: true, status: true },
      });
    });
    if (!row) {
      this.log.warn(`nhcx inbound message disappeared id=${inboundMessageId}`);
      return;
    }
    if (row.status !== 'pending') {
      this.log.log(
        `nhcx inbound already processed id=${inboundMessageId} status=${row.status}`,
      );
      return;
    }
    if (!row.claimId) {
      throw new Error('inbound row has no claimId — outbound was not claim-scoped');
    }

    const decrypted = await this.decryptBundle(input.body.payload);
    const operation = input.operation;

    let summary: Record<string, unknown> = { operation };

    if (operation === 'coverageeligibility/on_check') {
      const parsed = parseEligibilityResponse(decrypted);
      const out = await this.eligibility.handleInboundResponse({
        tenantId: row.tenantId,
        claimId: row.claimId,
        correlationId: input.correlationId,
        parsed,
      });
      summary = { ...summary, parsed, claimStatus: out.status };
    } else if (operation === 'preauth/on_submit') {
      const parsed = parsePreauthResponse(decrypted);
      // Slice AD: route through handleInboundResponse so the
      // QUEUED → SUBMITTED ack runs first when the claim is in real-
      // mode pending. applyDecision still works for the admin escape
      // hatch where the claim is already at SUBMITTED.
      const out = await this.preauth.handleInboundResponse({
        tenantId: row.tenantId,
        claimId: row.claimId,
        correlationId: input.correlationId,
        parsed,
      });
      summary = { ...summary, parsed, claimStatus: out.status };
    } else if (operation === 'claim/on_submit') {
      const parsed = parseClaimResponse(decrypted);
      // Slice AE: same two-step ack→decision shape as Slice AD's
      // preauth handler.
      const out = await this.claimSubmit.handleInboundResponse({
        tenantId: row.tenantId,
        claimId: row.claimId,
        correlationId: input.correlationId,
        parsed,
      });
      summary = { ...summary, parsed, claimStatus: out.status };
    } else if (operation === 'communication/request') {
      // Three different things route through communication/request,
      // disambiguated by the matching outbound's operation:
      //   1. discharge.submit outbound → discharge ack (Slice AF)
      //   2. preauth.query.respond outbound → query response ack
      //      (we already drove the state transition synchronously
      //      when we sent it; this is just the gateway confirming
      //      the message was relayed)
      //   3. no matching outbound → payer-initiated query, routed
      //      through preauth.applyDecision with kind=query_received
      //      (same path Slice Z established).
      const outboundOp = await this.lookupOutboundOperation(
        row.tenantId,
        input.correlationId,
      );
      if (outboundOp === 'discharge.submit') {
        const out = await this.discharge.handleInboundResponse({
          tenantId: row.tenantId,
          claimId: row.claimId,
          correlationId: input.correlationId,
        });
        summary = { ...summary, outboundOp, claimStatus: out.status };
      } else {
        const parsed = parseCommunication(decrypted);
        if (parsed.kind === 'query') {
          const out = await this.preauth.applyDecision({
            tenantId: row.tenantId,
            claimId: row.claimId,
            actorUserId: null,
            kind: 'query_received',
            queryText: parsed.text,
          });
          summary = { ...summary, parsed, claimStatus: out.status };
        } else {
          this.log.log(
            `nhcx communication response received correlationId=${input.correlationId}`,
          );
          summary = { ...summary, parsed };
        }
      }
    }

    await this.markSucceeded(inboundMessageId, summary, decrypted);
  }

  // Look up the outbound integration_message row that paired this
  // inbound's correlationId. Returns the outbound's operation, or
  // null when no matching outbound exists. Used by the
  // communication/request handler to disambiguate discharge ack vs.
  // payer query.
  private async lookupOutboundOperation(
    tenantId: string,
    correlationId: string,
  ): Promise<string | null> {
    const out = await this.prisma.runInTenantContext(
      tenantId,
      'platform_admin',
      (tx) =>
        tx.integrationMessage.findFirst({
          where: {
            correlationId,
            direction: 'outbound',
            integration: 'nhcx',
          },
          select: { operation: true },
        }),
    );
    return out?.operation ?? null;
  }

  // Decrypt the compact JWE using the private key indicated by the
  // 'kid' header. Falls back to the legacy single-key path when no
  // resolver is wired (mirrors the JWE adapter's optional-injection
  // pattern from Slice U).
  private async decryptBundle(compactJwe: string): Promise<unknown> {
    const kid = readJweKid(compactJwe);
    let pem: string | null = null;
    if (this.keyResolver && kid) {
      pem = this.keyResolver.privateKeyForVersion(kid);
      if (!pem) {
        throw new Error(
          `nhcx inbound JWE references unknown kid=${kid}; configure NHCX_PRIVATE_KEY_BASE64 / _V2 / etc.`,
        );
      }
    } else if (this.keyResolver) {
      // No kid — assume active key.
      pem = this.keyResolver.activePrivateKey().pem;
    } else {
      // Legacy single-key fallback for test rigs.
      pem = this.config.get('nhcxPrivateKeyPem', { infer: true });
    }
    if (!pem) {
      throw new Error('nhcx inbound: no private key available to decrypt');
    }
    return decryptFromParticipant<unknown>(compactJwe, pem);
  }

  private async markSucceeded(
    inboundMessageId: string,
    summary: Record<string, unknown>,
    decryptedBundle: unknown,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.role', 'platform_admin', true)`;
      await tx.integrationMessage.update({
        where: { id: inboundMessageId },
        data: {
          status: 'succeeded',
          completedAt: new Date(),
          rawResponse: { summary, decrypted: decryptedBundle } as never,
        },
      });
    });
  }

  private async markFailed(
    inboundMessageId: string,
    errorName: string,
    failureMessage: string,
  ): Promise<void> {
    const failureClass = classifyFailure(errorName, failureMessage);
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.role', 'platform_admin', true)`;
      await tx.integrationMessage.update({
        where: { id: inboundMessageId },
        data: {
          status: 'failed',
          completedAt: new Date(),
          failureClass,
          rawResponse: { failureMessage, errorName } as never,
        },
      });
    });
  }
}

function classifyFailure(errorName: string, message: string): string {
  if (errorName === 'FhirParseError' || message.includes('Bundle')) return 'parse';
  if (errorName === 'InvalidClaimTransitionError' || /state machine/i.test(message)) {
    return 'state-machine';
  }
  if (
    errorName === 'JOSEError' ||
    errorName === 'JWEDecryptionFailed' ||
    errorName === 'JWEInvalid' ||
    /decrypt|JWE|kid|jwe/i.test(message)
  ) {
    return 'crypto';
  }
  return 'unknown';
}
