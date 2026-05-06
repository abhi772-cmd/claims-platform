import {
  Permissions,
  type RemittanceBatchRequest,
  RemittanceBatchRequestSchema,
  type RemittanceBatchResponse,
} from '@claims/contracts';
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
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
}
