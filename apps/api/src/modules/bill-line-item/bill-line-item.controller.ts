// T2-13 follow-up — bill line item endpoints.
//
//   GET  /cases/:caseId/claims/:claimId/bill-line-items
//   POST /cases/:caseId/claims/:claimId/bill-line-items
//
// Both gated on claim.draft — operators who can draft a claim can
// save / view its bill line items.

import {
  type BillLineItemsListResponse,
  type SaveBillLineItemsRequest,
  SaveBillLineItemsRequestSchema,
  Permissions,
} from '@claims/contracts';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Request } from 'express';

import { BillLineItemService } from './bill-line-item.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CaseService } from '../case';

@ApiTags('bill-line-item')
@Controller('cases/:caseId/claims/:claimId/bill-line-items')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BillLineItemController {
  constructor(
    private readonly billLines: BillLineItemService,
    private readonly cases: CaseService,
  ) {}

  @Get()
  @RequirePermission(Permissions.CLAIM_DRAFT)
  async list(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<BillLineItemsListResponse> {
    await this.assertOwns(user.tenantId, caseId, claimId);
    return this.billLines.listForClaim(user.tenantId, claimId);
  }

  @Post()
  @HttpCode(200)
  @RequirePermission(Permissions.CLAIM_DRAFT)
  async save(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body(new ZodValidationPipe(SaveBillLineItemsRequestSchema))
    body: SaveBillLineItemsRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
    @Req() req: Request,
  ): Promise<BillLineItemsListResponse> {
    await this.assertOwns(user.tenantId, caseId, claimId);
    return this.billLines.replaceForClaim({
      tenantId: user.tenantId,
      claimId,
      actorUserId: user.userId,
      lines: body.lines,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
  }

  private async assertOwns(tenantId: string, caseId: string, claimId: string): Promise<void> {
    const detail = await this.cases.getById(tenantId, caseId);
    const owns = detail.claims.some((c) => c.id === claimId);
    if (!owns) throw new ValidationFailedError({ claimId: ['Claim not on this case.'] });
  }
}
