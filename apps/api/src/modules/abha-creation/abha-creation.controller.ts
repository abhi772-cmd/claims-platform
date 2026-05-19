// Phase 2 — ABDM ABHA creation endpoints. Two-step Aadhaar OTP flow:
//
//   POST /abha/init    body: { aadhaar }
//                      returns: { txnId, mobileMasked, fullNameHint? }
//
//   POST /abha/verify  body: { txnId, otp }
//                      returns: { abhaNumber, healthIdNumber?,
//                                 fullName?, gender?, dateOfBirth? }
//
// Permission: CASE_CREATE — the operator who can create a case can
// generate an ABHA for the patient at intake. No new permission until
// the desk separation (lookup vs intake) actually exists.

import {
  type AbhaCreateInitRequest,
  AbhaCreateInitRequestSchema,
  type AbhaCreateInitResponse,
  type AbhaCreateVerifyRequest,
  AbhaCreateVerifyRequestSchema,
  type AbhaCreateVerifyResponse,
  Permissions,
} from '@claims/contracts';
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { AbhaCreationService } from './abha-creation.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('abha')
@Controller('abha')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AbhaCreationController {
  constructor(private readonly service: AbhaCreationService) {}

  @Post('init')
  @HttpCode(200)
  @RequirePermission(Permissions.CASE_CREATE)
  async init(
    @Body(new ZodValidationPipe(AbhaCreateInitRequestSchema))
    body: AbhaCreateInitRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<AbhaCreateInitResponse> {
    return this.service.init({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      aadhaar: body.aadhaar,
    });
  }

  @Post('verify')
  @HttpCode(200)
  @RequirePermission(Permissions.CASE_CREATE)
  async verify(
    @Body(new ZodValidationPipe(AbhaCreateVerifyRequestSchema))
    body: AbhaCreateVerifyRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<AbhaCreateVerifyResponse> {
    return this.service.verify({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      txnId: body.txnId,
      otp: body.otp,
    });
  }
}
