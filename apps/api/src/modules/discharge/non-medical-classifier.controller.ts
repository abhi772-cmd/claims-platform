// T2-13 — non-medical classifier endpoint.
//
// POST /discharge/classify-non-medical
//
// Body: { lines: [{ description, amountPaise }, …] }
// Returns: each line tagged + totals + by-category breakdown.
//
// Strict utility: no DB read or write, no tenant data crosses, no
// audit row written. Gated on claim.draft (operators who can draft a
// claim can use this calculator at discharge time).

import {
  type ClassifyNonMedicalRequest,
  ClassifyNonMedicalRequestSchema,
  type ClassifyNonMedicalResponse,
  Permissions,
} from '@claims/contracts';
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { classifyBillLines } from './non-medical-classifier';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('discharge')
@Controller('discharge')
@UseGuards(JwtAuthGuard, RolesGuard)
export class NonMedicalClassifierController {
  @Post('classify-non-medical')
  @HttpCode(200)
  @RequirePermission(Permissions.CLAIM_DRAFT)
  classify(
    @Body(new ZodValidationPipe(ClassifyNonMedicalRequestSchema))
    body: ClassifyNonMedicalRequest,
  ): ClassifyNonMedicalResponse {
    return classifyBillLines(body.lines);
  }
}
