import {
  type LumpSumAllocateRequest,
  LumpSumAllocateRequestSchema,
  type LumpSumAllocateResponse,
  Permissions,
  type RemittanceBatchRequest,
  RemittanceBatchRequestSchema,
  type RemittanceBatchResponse,
  type RemittanceCandidatesResponse,
} from '@claims/contracts';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { RemittanceService } from './remittance.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

// Slice AL — bulk remittance reconciliation. Operators upload the
// payer's daily / weekly remittance file (CSV / Excel parsed
// client-side into RemittanceRow[]) and POST the batch here. Per-row
// outcomes come back in the response so the UI can render a summary
// without follow-up requests. settlement.upload_eob is the gating
// permission — same operator role that records receipts manually.
@ApiTags('settlement')
@Controller('settlement/remittance')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RemittanceController {
  constructor(private readonly remittance: RemittanceService) {}

  @Post()
  @HttpCode(200)
  @RequirePermission(Permissions.SETTLEMENT_UPLOAD_EOB)
  async processBatch(
    @Body(new ZodValidationPipe(RemittanceBatchRequestSchema))
    body: RemittanceBatchRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<RemittanceBatchResponse> {
    return this.remittance.processBatch({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      rows: body.rows,
    });
  }

  // T3-2 — operator pastes a bank UTR + total, the API returns open
  // settlements (optionally narrowed to a single payer) so the
  // operator can pick + allocate. Read-only; gated on the same
  // permission as the batch upload.
  @Get('candidates')
  @RequirePermission(Permissions.SETTLEMENT_UPLOAD_EOB)
  async candidates(
    @Query('payerCode') payerCode: string | undefined,
    @Query('limit') limit: string | undefined,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<RemittanceCandidatesResponse> {
    const parsedLimit =
      limit !== undefined && /^\d+$/.test(limit) ? Number.parseInt(limit, 10) : undefined;
    return this.remittance.proposeCandidates({
      tenantId: user.tenantId,
      ...(payerCode !== undefined && payerCode.length > 0 ? { payerCode } : {}),
      ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
    });
  }

  // T3-2 — atomic application of an operator-built lump-sum
  // allocation. Each per-claim leg goes through the same recordReceipt
  // path as a manual receipt, so audit + state-machine semantics are
  // unchanged. Failed legs don't roll back applied legs (matches
  // processBatch).
  @Post('lump-sum')
  @HttpCode(200)
  @RequirePermission(Permissions.SETTLEMENT_UPLOAD_EOB)
  async allocateLumpSum(
    @Body(new ZodValidationPipe(LumpSumAllocateRequestSchema))
    body: LumpSumAllocateRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<LumpSumAllocateResponse> {
    return this.remittance.allocateLumpSum({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      bankTxnId: body.bankTxnId,
      totalAmount: body.totalAmount,
      ...(body.receivedAt !== undefined ? { receivedAt: new Date(body.receivedAt) } : {}),
      ...(body.payerCode !== undefined ? { payerCode: body.payerCode } : {}),
      allocations: body.allocations,
    });
  }
}
