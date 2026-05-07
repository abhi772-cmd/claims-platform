import {
  type DeductionLine,
  type PaymentMode,
  type ReconciliationStatus,
  type Settlement,
} from '@claims/contracts';
import { Injectable } from '@nestjs/common';

import { ValidationFailedError } from '../../common/errors/validation-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ClaimService } from '../claim';

export interface ExpectPaymentInput {
  tenantId: string;
  claimId: string;
  actorUserId: string;
  paymentMode: PaymentMode;
  expectedAmount?: number;
}

export interface RecordReceiptInput {
  tenantId: string;
  claimId: string;
  // Slice BC — null when the call is gateway-driven (an inbound
  // PaymentNotice rather than an operator-clicked Record receipt).
  // claim_event.actorUserId is nullable on the DB side, so this
  // propagates through the transition writes without further
  // accommodation.
  actorUserId: string | null;
  receivedAmount: number;
  receivedAt?: Date;
  eobDocumentId?: string;
  bankTxnId?: string;
  shortPaymentReasons?: string[];
}

export interface ReconcileInput {
  tenantId: string;
  claimId: string;
  actorUserId: string;
  deductions?: DeductionLine[];
}

export interface WriteOffInput {
  tenantId: string;
  claimId: string;
  actorUserId: string;
  reason: string;
}

export interface CloseInput {
  tenantId: string;
  claimId: string;
  actorUserId: string;
}

@Injectable()
export class SettlementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly claims: ClaimService,
  ) {}

  // 1. Open the Settlement row + drive payment.expected on the claim.
  // Idempotent — if a row already exists, we update the paymentMode
  // + expectedAmount but don't re-fire the transition (the state
  // machine would reject it anyway).
  async expectPayment(input: ExpectPaymentInput): Promise<Settlement> {
    const settlement = await this.prisma.runInTenantContext(
      input.tenantId,
      'tenant',
      async (tx) => {
        const claim = await tx.claim.findUnique({ where: { id: input.claimId } });
        if (!claim || claim.tenantId !== input.tenantId) {
          throw new ValidationFailedError({ claimId: ['Claim not found.'] });
        }
        const expected = input.expectedAmount ?? claim.approvedAmount ?? 0;
        if (expected <= 0) {
          throw new ValidationFailedError({
            expectedAmount: ['Approved amount missing — pass expectedAmount explicitly.'],
          });
        }
        const row = await tx.settlement.upsert({
          where: { claimId: input.claimId },
          create: {
            tenantId: input.tenantId,
            claimId: input.claimId,
            paymentMode: input.paymentMode,
            expectedAmount: expected,
          },
          update: {
            paymentMode: input.paymentMode,
            expectedAmount: expected,
          },
        });
        return row;
      },
    );

    // Drive the state-machine event only if the claim's status warrants
    // it. From CLAIM_APPROVED / CLAIM_PARTIALLY_APPROVED / APPEAL_RESOLVED
    // payment.expected is allowed; idempotent re-entry from PAYMENT_PENDING
    // is rejected by the state machine, which is the right answer.
    try {
      await this.claims.transition({
        tenantId: input.tenantId,
        claimId: input.claimId,
        eventType: 'payment.expected',
        actorUserId: input.actorUserId,
      });
    } catch (err) {
      // Swallow same-status repeats. Anything else flows up.
      const code = (err as { code?: string }).code;
      if (code !== 'VALIDATION_FAILED') throw err;
    }
    return toSettlement(settlement);
  }

  async recordReceipt(input: RecordReceiptInput): Promise<Settlement> {
    const settlement = await this.prisma.runInTenantContext(
      input.tenantId,
      'tenant',
      async (tx) => {
        const row = await tx.settlement.findUnique({ where: { claimId: input.claimId } });
        if (!row) {
          throw new ValidationFailedError({
            settlement: ['No settlement open — call /expect first.'],
          });
        }
        const expected = row.expectedAmount;
        const isShort = input.receivedAmount < expected;
        const deductionAmount = Math.max(0, expected - input.receivedAmount);

        const updated = await tx.settlement.update({
          where: { claimId: input.claimId },
          data: {
            receivedAmount: input.receivedAmount,
            receivedAt: input.receivedAt ?? new Date(),
            ...(input.eobDocumentId !== undefined ? { eobDocumentId: input.eobDocumentId } : {}),
            ...(input.bankTxnId !== undefined ? { bankTxnId: input.bankTxnId } : {}),
            deductionAmount,
            shortPaymentReasons: (input.shortPaymentReasons ?? []) as never,
            reconciliationStatus: isShort
              ? ('short_paid' satisfies ReconciliationStatus)
              : ('manual_match_pending' satisfies ReconciliationStatus),
          },
        });
        return toSettlement(updated);
      },
    );

    // The state machine treats SHORT_PAID as a refinement of RECEIVED,
    // not an alternative — payment.short_paid only fires from
    // PAYMENT_RECEIVED. So always drive payment.received first, then
    // chain payment.short_paid when the receipt is partial.
    await this.claims.transition({
      tenantId: input.tenantId,
      claimId: input.claimId,
      eventType: 'payment.received',
      actorUserId: input.actorUserId,
      patch: { paidAmount: input.receivedAmount },
    });
    const isShort = (settlement.receivedAmount ?? 0) < settlement.expectedAmount;
    if (isShort) {
      await this.claims.transition({
        tenantId: input.tenantId,
        claimId: input.claimId,
        eventType: 'payment.short_paid',
        actorUserId: input.actorUserId,
      });
    }
    return settlement;
  }

  async reconcile(input: ReconcileInput): Promise<Settlement> {
    return this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      const settlement = await tx.settlement.findUnique({ where: { claimId: input.claimId } });
      if (!settlement) {
        throw new ValidationFailedError({
          settlement: ['No settlement to reconcile.'],
        });
      }
      const updated = await tx.settlement.update({
        where: { claimId: input.claimId },
        data: {
          deductions: (input.deductions ?? []) as never,
          reconciliationStatus: 'auto_matched' satisfies ReconciliationStatus,
        },
      });
      return toSettlement(updated);
    }).then(async (s) => {
      await this.claims.transition({
        tenantId: input.tenantId,
        claimId: input.claimId,
        eventType: 'payment.reconciled',
        actorUserId: input.actorUserId,
      });
      return s;
    });
  }

  async writeOff(input: WriteOffInput): Promise<Settlement> {
    return this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      const settlement = await tx.settlement.findUnique({ where: { claimId: input.claimId } });
      if (!settlement) {
        throw new ValidationFailedError({ settlement: ['No settlement open.'] });
      }
      const updated = await tx.settlement.update({
        where: { claimId: input.claimId },
        data: {
          shortPaymentReasons: [input.reason] as never,
          reconciliationStatus: 'discrepancy' satisfies ReconciliationStatus,
        },
      });
      return toSettlement(updated);
    }).then(async (s) => {
      await this.claims.transition({
        tenantId: input.tenantId,
        claimId: input.claimId,
        eventType: 'claim.written_off',
        actorUserId: input.actorUserId,
        payload: { reason: input.reason },
      });
      return s;
    });
  }

  async close(input: CloseInput): Promise<Settlement> {
    const snap = await this.claims.transition({
      tenantId: input.tenantId,
      claimId: input.claimId,
      eventType: 'claim.closed',
      actorUserId: input.actorUserId,
    });
    void snap;
    return this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      const updated = await tx.settlement.update({
        where: { claimId: input.claimId },
        data: { closedAt: new Date() },
      });
      return toSettlement(updated);
    });
  }

  async getByClaim(tenantId: string, claimId: string): Promise<Settlement | null> {
    const row = await this.prisma.runInTenantContext(tenantId, 'tenant', (tx) =>
      tx.settlement.findUnique({ where: { claimId } }),
    );
    return row ? toSettlement(row) : null;
  }
}

function toSettlement(row: {
  id: string;
  claimId: string;
  paymentMode: string;
  expectedAmount: number;
  receivedAmount: number | null;
  deductionAmount: number | null;
  deductions: unknown;
  shortPaymentReasons: unknown;
  receivedAt: Date | null;
  eobDocumentId: string | null;
  bankTxnId: string | null;
  reconciliationStatus: string;
  closedAt: Date | null;
}): Settlement {
  return {
    id: row.id,
    claimId: row.claimId,
    paymentMode: row.paymentMode as PaymentMode,
    expectedAmount: row.expectedAmount,
    receivedAmount: row.receivedAmount,
    deductionAmount: row.deductionAmount,
    deductions: Array.isArray(row.deductions)
      ? (row.deductions as DeductionLine[])
      : [],
    receivedAt: row.receivedAt ? row.receivedAt.toISOString() : null,
    eobDocumentId: row.eobDocumentId,
    bankTxnId: row.bankTxnId,
    reconciliationStatus: row.reconciliationStatus as ReconciliationStatus,
    shortPaymentReasons: Array.isArray(row.shortPaymentReasons)
      ? (row.shortPaymentReasons as string[])
      : [],
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
  };
}
