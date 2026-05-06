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
import { PrismaService } from '../../../common/prisma/prisma.service';
import { type AppConfig } from '../../../config/configuration';
import { ClaimSubmitService } from '../../claim-submit/claim-submit.service';
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
  // 'accepted' = persisted + scheduled. 'duplicate' = already had a
  // row for this correlationId (idempotency guard fired). 'invalid'
  // = malformed payload or missing key — controller still returns
  // 200 (the gateway shouldn't retry on a bad request) but ops sees
  // the failure on the row.
  outcome: 'accepted' | 'duplicate' | 'invalid';
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
    private readonly config: ConfigService<AppConfig, true>,
    @Optional() @Inject(NHCX_KEY_RESOLVER) private readonly keyResolver: NhcxKeyResolver | null,
  ) {}

  // Step 1 — synchronous. The controller must complete this and reply
  // 200 within the gateway's timeout (typically 5s). We do exactly two
  // things here: idempotency check + persist.
  async receive(
    input: InboundDispatchInput,
  ): Promise<InboundDispatchResult> {
    // Idempotency: NHA may retry on transient failures. A repeat
    // correlationId on the inbound side is benign — log + skip.
    // The lookup runs in platform_admin context because we don't yet
    // know the tenantId (it's resolved from the matching outbound row
    // during async processing).
    const existing = await this.prisma.integrationMessage.findFirst({
      where: {
        correlationId: input.correlationId,
        direction: 'inbound',
        integration: 'nhcx',
      },
      select: { id: true, tenantId: true, status: true },
    });
    if (existing) {
      this.log.log(
        `nhcx inbound duplicate correlationId=${input.correlationId} existingId=${existing.id} status=${existing.status}`,
      );
      return { inboundMessageId: existing.id, outcome: 'duplicate' };
    }

    // Find the matching outbound row to learn which tenant + claim
    // this callback belongs to. Without it we have no tenant context
    // to write the inbound row under. If no outbound exists this is
    // either a misrouted callback or a bundle we never sent — log
    // and reject by writing nothing.
    const outbound = await this.prisma.integrationMessage.findFirst({
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
      // Persist a tenantless row would violate RLS — instead drop it
      // and rely on gateway-side correlation for forensics. We still
      // return 200 to the controller so the gateway doesn't retry.
      return { inboundMessageId: '', outcome: 'invalid' };
    }

    // Persist the inbound row in the matching outbound's tenant
    // context so RLS holds. Status starts as 'pending'; the async
    // step flips to 'succeeded' / 'failed'.
    const inboundRow = await this.prisma.runInTenantContext(
      outbound.tenantId,
      'platform_admin',
      (tx) =>
        tx.integrationMessage.create({
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
        }),
    );

    return { inboundMessageId: inboundRow.id, outcome: 'accepted' };
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
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(
        `nhcx inbound processing failed correlationId=${input.correlationId} err=${message}`,
      );
      await this.markFailed(inboundMessageId, message);
    }
  }

  private async processInternal(
    inboundMessageId: string,
    input: InboundDispatchInput,
  ): Promise<void> {
    const row = await this.prisma.integrationMessage.findUnique({
      where: { id: inboundMessageId },
      select: { tenantId: true, claimId: true, status: true },
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
      const out = await this.preauth.applyDecision({
        tenantId: row.tenantId,
        claimId: row.claimId,
        actorUserId: null,
        kind: parsed.kind,
        ...(parsed.approvedAmount !== undefined ? { approvedAmount: parsed.approvedAmount } : {}),
        ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
        ...(parsed.queryText !== undefined ? { queryText: parsed.queryText } : {}),
      });
      summary = { ...summary, parsed, claimStatus: out.status };
    } else if (operation === 'claim/on_submit') {
      const parsed = parseClaimResponse(decrypted);
      const out = await this.claimSubmit.applyDecision({
        tenantId: row.tenantId,
        claimId: row.claimId,
        actorUserId: null,
        kind: parsed.kind,
        ...(parsed.approvedAmount !== undefined ? { approvedAmount: parsed.approvedAmount } : {}),
        ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
        ...(parsed.queryText !== undefined ? { queryText: parsed.queryText } : {}),
      });
      summary = { ...summary, parsed, claimStatus: out.status };
    } else if (operation === 'communication/request') {
      const parsed = parseCommunication(decrypted);
      if (parsed.kind === 'query') {
        // Inbound payer query → routed through preauth.applyDecision
        // with kind=query_received so a PreauthQuery row is created
        // and the claim transitions to QUERY_RAISED. (Same path the
        // admin escape hatch uses today — we just feed it from the
        // gateway instead.)
        const out = await this.preauth.applyDecision({
          tenantId: row.tenantId,
          claimId: row.claimId,
          actorUserId: null,
          kind: 'query_received',
          queryText: parsed.text,
        });
        summary = { ...summary, parsed, claimStatus: out.status };
      } else {
        // 'response' — log only. The original outbound query response
        // already drove the state transition; this is the gateway
        // confirming our message was relayed.
        this.log.log(
          `nhcx communication response received correlationId=${input.correlationId}`,
        );
        summary = { ...summary, parsed };
      }
    }

    await this.markSucceeded(inboundMessageId, summary, decrypted);
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
    const row = await this.prisma.integrationMessage.findUnique({
      where: { id: inboundMessageId },
      select: { tenantId: true },
    });
    if (!row) return;
    await this.prisma.runInTenantContext(row.tenantId, 'platform_admin', (tx) =>
      tx.integrationMessage.update({
        where: { id: inboundMessageId },
        data: {
          status: 'succeeded',
          completedAt: new Date(),
          rawResponse: { summary, decrypted: decryptedBundle } as never,
        },
      }),
    );
  }

  private async markFailed(
    inboundMessageId: string,
    failureMessage: string,
  ): Promise<void> {
    const row = await this.prisma.integrationMessage.findUnique({
      where: { id: inboundMessageId },
      select: { tenantId: true },
    });
    if (!row) return;
    const failureClass = classifyFailure(failureMessage);
    await this.prisma.runInTenantContext(row.tenantId, 'platform_admin', (tx) =>
      tx.integrationMessage.update({
        where: { id: inboundMessageId },
        data: {
          status: 'failed',
          completedAt: new Date(),
          failureClass,
          rawResponse: { failureMessage } as never,
        },
      }),
    );
  }
}

function classifyFailure(message: string): string {
  if (message.includes('Bundle') || message.includes('FhirParseError')) return 'parse';
  if (/decrypt|JWE|kid/i.test(message)) return 'crypto';
  if (/InvalidClaimTransition|state machine/i.test(message)) return 'state-machine';
  return 'unknown';
}
