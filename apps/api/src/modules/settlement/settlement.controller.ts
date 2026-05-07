import {
  type ExpectPaymentRequest,
  ExpectPaymentRequestSchema,
  Permissions,
  type ReconcileRequest,
  ReconcileRequestSchema,
  type RecordReceiptRequest,
  RecordReceiptRequestSchema,
  type Settlement,
  type SettlementResponse,
  type WriteOffRequest,
  WriteOffRequestSchema,
} from '@claims/contracts';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { SettlementService } from './settlement.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CaseService } from '../case';
import { ClaimService } from '../claim';

@ApiTags('settlement')
@Controller('cases/:caseId/claims/:claimId/settlement')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SettlementController {
  constructor(
    private readonly settlement: SettlementService,
    private readonly cases: CaseService,
    private readonly claims: ClaimService,
  ) {}

  @Get()
  @RequirePermission(Permissions.CASE_VIEW)
  async getByClaim(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<{ settlement: Settlement | null }> {
    await this.assertOwns(user.tenantId, caseId, claimId);
    const settlement = await this.settlement.getByClaim(user.tenantId, claimId);
    return { settlement };
  }

  @Post('expect')
  @HttpCode(200)
  @RequirePermission(Permissions.CASE_ASSIGN)
  async expect(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body(new ZodValidationPipe(ExpectPaymentRequestSchema)) body: ExpectPaymentRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<SettlementResponse> {
    await this.assertOwns(user.tenantId, caseId, claimId);
    const settlement = await this.settlement.expectPayment({
      tenantId: user.tenantId,
      claimId,
      actorUserId: user.userId,
      paymentMode: body.paymentMode,
      ...(body.expectedAmount !== undefined ? { expectedAmount: body.expectedAmount } : {}),
    });
    const claim = await this.claims.findById(user.tenantId, claimId);
    return { settlement, status: claim?.status ?? '' };
  }

  @Post('receipt')
  @HttpCode(200)
  @RequirePermission(Permissions.SETTLEMENT_UPLOAD_EOB)
  async receipt(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body(new ZodValidationPipe(RecordReceiptRequestSchema)) body: RecordReceiptRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<SettlementResponse> {
    await this.assertOwns(user.tenantId, caseId, claimId);
    const settlement = await this.settlement.recordReceipt({
      tenantId: user.tenantId,
      claimId,
      actorUserId: user.userId,
      receivedAmount: body.receivedAmount,
      ...(body.receivedAt !== undefined ? { receivedAt: new Date(body.receivedAt) } : {}),
      ...(body.eobDocumentId !== undefined ? { eobDocumentId: body.eobDocumentId } : {}),
      ...(body.bankTxnId !== undefined ? { bankTxnId: body.bankTxnId } : {}),
      ...(body.shortPaymentReasons !== undefined
        ? { shortPaymentReasons: body.shortPaymentReasons }
        : {}),
    });
    const claim = await this.claims.findById(user.tenantId, claimId);
    return { settlement, status: claim?.status ?? '' };
  }

  @Post('reconcile')
  @HttpCode(200)
  @RequirePermission(Permissions.SETTLEMENT_CATEGORIZE_DEDUCT)
  async reconcile(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body(new ZodValidationPipe(ReconcileRequestSchema)) body: ReconcileRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<SettlementResponse> {
    await this.assertOwns(user.tenantId, caseId, claimId);
    const settlement = await this.settlement.reconcile({
      tenantId: user.tenantId,
      claimId,
      actorUserId: user.userId,
      ...(body.deductions !== undefined ? { deductions: body.deductions } : {}),
    });
    const claim = await this.claims.findById(user.tenantId, claimId);
    return { settlement, status: claim?.status ?? '' };
  }

  @Post('write-off')
  @HttpCode(200)
  @RequirePermission(Permissions.SETTLEMENT_WRITE_OFF)
  async writeOff(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body(new ZodValidationPipe(WriteOffRequestSchema)) body: WriteOffRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<SettlementResponse> {
    await this.assertOwns(user.tenantId, caseId, claimId);
    const settlement = await this.settlement.writeOff({
      tenantId: user.tenantId,
      claimId,
      actorUserId: user.userId,
      reason: body.reason,
    });
    const claim = await this.claims.findById(user.tenantId, claimId);
    return { settlement, status: claim?.status ?? '' };
  }

  @Post('close')
  @HttpCode(200)
  @RequirePermission(Permissions.SETTLEMENT_CATEGORIZE_DEDUCT)
  async close(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<SettlementResponse> {
    await this.assertOwns(user.tenantId, caseId, claimId);
    const settlement = await this.settlement.close({
      tenantId: user.tenantId,
      claimId,
      actorUserId: user.userId,
    });
    const claim = await this.claims.findById(user.tenantId, claimId);
    return { settlement, status: claim?.status ?? '' };
  }

  private async assertOwns(tenantId: string, caseId: string, claimId: string): Promise<void> {
    const detail = await this.cases.getById(tenantId, caseId);
    const owns = detail.claims.some((c) => c.id === claimId);
    if (!owns) throw new ValidationFailedError({ claimId: ['Claim not on this case.'] });
  }
}
