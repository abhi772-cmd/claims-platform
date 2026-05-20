// Bill-OCR endpoint — operator uploads a hospital final bill and gets
// parsed line items to seed the non-medical classifier (T2-13),
// replacing the paste-as-text step.
//
// POST /discharge/extract-bill
//
// Body: { fileBase64, contentType, originalFilename? }
// Returns: { status, engine, lines: [{ description, amountPaise }], error? }
//
// Stateless: no DB read/write, no Document row, nothing persisted. The
// bytes are forwarded to the bill-OCR inference service. Gated on
// claim.draft — same as the classifier (operators who can draft a
// claim can use the discharge calculator).

import {
  type BillOcrExtractRequest,
  BillOcrExtractRequestSchema,
  type BillOcrExtractResponse,
  Permissions,
} from '@claims/contracts';
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { BillExtractService } from './bill-extract.service';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('discharge')
@Controller('discharge')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BillExtractController {
  constructor(private readonly billExtract: BillExtractService) {}

  @Post('extract-bill')
  @HttpCode(200)
  @RequirePermission(Permissions.CLAIM_DRAFT)
  extract(
    @Body(new ZodValidationPipe(BillOcrExtractRequestSchema))
    body: BillOcrExtractRequest,
  ): Promise<BillOcrExtractResponse> {
    return this.billExtract.extract(body);
  }
}
