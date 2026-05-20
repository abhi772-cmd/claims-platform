// Slice CM — DPDP consent OTP capture endpoints.
//
// Routes:
//   POST /consents/otp/initiate — manage; mint + dispatch a 6-digit code
//   POST /consents/otp/verify   — manage; match the code; flip to verified
//
// Verify returns the otpId the case-create flow then threads into
// GrantConsent.acknowledgementRef. The consent_record row is NOT
// created here — that happens atomically with the patient + case in
// CaseService.create. This split keeps the form-resubmit safe: an
// operator who reloads the case form between verify and case-submit
// still has the verified OTP id to attach.

import {
  type ConsentOtpInitiateRequest,
  ConsentOtpInitiateSchema,
  type ConsentOtpInitiateResponse,
  type ConsentOtpVerifyRequest,
  ConsentOtpVerifySchema,
  type ConsentOtpVerifyResponse,
  Permissions,
} from '@claims/contracts';
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ConsentOtpService } from './consent-otp.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('consents')
@Controller('consents/otp')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ConsentOtpController {
  constructor(private readonly service: ConsentOtpService) {}

  @Post('initiate')
  @HttpCode(200)
  @RequirePermission(Permissions.CONSENT_MANAGE)
  async initiate(
    @Body(new ZodValidationPipe(ConsentOtpInitiateSchema)) body: ConsentOtpInitiateRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<ConsentOtpInitiateResponse> {
    const result = await this.service.initiate({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      mobile: body.mobile,
      consentType: body.consentType,
      noticeText: body.noticeText,
      ...(body.locales ? { locales: body.locales } : {}),
    });
    return {
      otpId: result.otpId,
      mobileLast4: result.mobileLast4,
      expiresAt: result.expiresAt.toISOString(),
    };
  }

  @Post('verify')
  @HttpCode(200)
  @RequirePermission(Permissions.CONSENT_MANAGE)
  async verify(
    @Body(new ZodValidationPipe(ConsentOtpVerifySchema)) body: ConsentOtpVerifyRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<ConsentOtpVerifyResponse> {
    const result = await this.service.verify({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      otpId: body.otpId,
      code: body.code,
    });
    return {
      otpId: result.otpId,
      verifiedAt: result.verifiedAt.toISOString(),
    };
  }
}
