import {
  type DoctorTokenPreview,
  type IssueDoctorTokenRequest,
  IssueDoctorTokenRequestSchema,
  type IssueDoctorTokenResponse,
  Permissions,
  type RequestHprOtpRequest,
  RequestHprOtpRequestSchema,
  type RequestHprOtpResponse,
  type SignWithDoctorTokenRequest,
  SignWithDoctorTokenRequestSchema,
  type SignWithDoctorTokenResponse,
} from '@claims/contracts';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { type Request } from 'express';

import { DoctorTokenService } from './doctor-token.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('preauth/doctor-tokens')
export class DoctorTokenController {
  constructor(private readonly tokens: DoctorTokenService) {}

  // Authenticated — only users with preauth.sign_clinical (the insurance
  // desk role on this tenant) can request a doctor link. The doctor
  // themself doesn't need it; they identify via the link + HPR OTP.
  @Post()
  @HttpCode(201)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RequirePermission(Permissions.PREAUTH_SIGN_CLINICAL)
  async issue(
    @Body(new ZodValidationPipe(IssueDoctorTokenRequestSchema)) body: IssueDoctorTokenRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
    @Req() req: Request,
  ): Promise<IssueDoctorTokenResponse> {
    const out = await this.tokens.issue({
      tenantId: user.tenantId,
      doctorUserId: body.doctorUserId,
      createdById: user.userId,
      caseRef: body.caseRef,
      patientName: body.patientName,
      scope: body.scope,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    return { tokenId: out.tokenId, expiresAt: out.expiresAt.toISOString() };
  }

  // Public — used by the doctor's link landing page. Lookup by raw token,
  // returns a small preview (no PII beyond patient name + case ref).
  @Get(':rawToken/preview')
  async preview(@Param('rawToken') rawToken: string): Promise<DoctorTokenPreview> {
    const out = await this.tokens.preview(rawToken);
    return {
      doctorFirstName: out.doctorFirstName,
      doctorLastName: out.doctorLastName,
      caseRef: out.caseRef,
      patientName: out.patientName,
      scope: out.scope,
      tenantDisplayName: out.tenantDisplayName,
      requesterName: out.requesterName,
      expiresAt: out.expiresAt.toISOString(),
    };
  }

  // Public — the doctor on the link landing page asks ABDM to send an
  // OTP to their registered mobile. Step 1 of the two-step real-ABDM
  // flow; for the stub, returns a synthetic transactionId.
  @Post(':rawToken/hpr-init')
  @HttpCode(200)
  async hprInit(
    @Param('rawToken') _rawToken: string,
    @Body(new ZodValidationPipe(RequestHprOtpRequestSchema)) body: RequestHprOtpRequest,
  ): Promise<RequestHprOtpResponse> {
    const out = await this.tokens.requestHprOtp(body.hprId);
    return { transactionId: out.transactionId, expiresAt: out.expiresAt };
  }

  @Post(':rawToken/sign')
  @HttpCode(200)
  async sign(
    @Param('rawToken') rawToken: string,
    @Body(new ZodValidationPipe(SignWithDoctorTokenRequestSchema)) body: SignWithDoctorTokenRequest,
    @Req() req: Request,
  ): Promise<SignWithDoctorTokenResponse> {
    const out = await this.tokens.sign({
      rawToken,
      hprId: body.hprId,
      hprOtp: body.hprOtp,
      ...(body.hprTransactionId !== undefined
        ? { hprTransactionId: body.hprTransactionId }
        : {}),
      ...(body.signatureNote !== undefined ? { signatureNote: body.signatureNote } : {}),
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    return {
      signedAt: out.signedAt.toISOString(),
      doctorFullName: out.doctorFullName,
      hprId: out.hprId,
    };
  }
}
