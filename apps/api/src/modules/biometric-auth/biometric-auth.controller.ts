// Slice BG — public endpoints for case-scoped ABDM biometric auth.
//
//   POST /cases/:caseId/biometric-auth/init    → adapter.init proxy
//   POST /cases/:caseId/biometric-auth/verify  → adapter.verify + persist
//
// Both endpoints require the same permission as preauth/submit
// because every role in the seed (`tenant_admin`, `billing_manager`,
// `insurance_desk_executive`, `pmam`) that has `claim.submit` also
// has `preauth.submit`. A dedicated `biometric.capture` permission
// is reasonable later but not load-bearing for BG.
//
// The verify endpoint enforces the "one PID block per authMode"
// invariant so the adapter call always carries a single device PID.
// Validation failures get a clean 422.

import {
  type BiometricInitRequest,
  BiometricInitRequestSchema,
  type BiometricInitResponse,
  type BiometricVerifyRequest,
  BiometricVerifyRequestSchema,
  type BiometricVerifyResponse,
  Permissions,
} from '@claims/contracts';
import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { BiometricAuthService } from './biometric-auth.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('biometric-auth')
@Controller('cases/:caseId/biometric-auth')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BiometricAuthController {
  constructor(private readonly biometric: BiometricAuthService) {}

  @Post('init')
  @HttpCode(200)
  @RequirePermission(Permissions.PREAUTH_SUBMIT)
  async init(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Body(new ZodValidationPipe(BiometricInitRequestSchema)) body: BiometricInitRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<BiometricInitResponse> {
    const result = await this.biometric.initiate({
      tenantId: user.tenantId,
      caseId,
      scope: body.scope,
      loginHint: body.loginHint,
      loginId: body.loginId,
      authMode: body.authMode,
      process: body.process,
      payerId: body.payerId,
      bearerToken: body.bearerToken,
    });
    return result.txnId !== undefined
      ? { status: result.status, txnId: result.txnId }
      : { status: result.status };
  }

  @Post('verify')
  @HttpCode(200)
  @RequirePermission(Permissions.PREAUTH_SUBMIT)
  async verify(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Body(new ZodValidationPipe(BiometricVerifyRequestSchema)) body: BiometricVerifyRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<BiometricVerifyResponse> {
    assertOnePidPerMode(body);
    const result = await this.biometric.verify({
      tenantId: user.tenantId,
      caseId,
      scope: body.scope,
      authMode: body.authMode,
      loginHint: body.loginHint,
      loginId: body.loginId,
      authData: {
        txnId: body.authData.txnId,
        ...(body.authData.fingerPrintAuthPid !== undefined
          ? { fingerPrintAuthPid: body.authData.fingerPrintAuthPid }
          : {}),
        ...(body.authData.faceAuthPid !== undefined
          ? { faceAuthPid: body.authData.faceAuthPid }
          : {}),
        ...(body.authData.irisAuthPid !== undefined
          ? { irisAuthPid: body.authData.irisAuthPid }
          : {}),
      },
      process: body.process,
      payerId: body.payerId,
      bearerToken: body.bearerToken,
    });
    return result.verificationId !== undefined &&
      result.verifiedAt !== undefined &&
      result.expiresAt !== undefined
      ? {
          status: result.status,
          verificationId: result.verificationId,
          verifiedAt: result.verifiedAt,
          expiresAt: result.expiresAt,
        }
      : { status: result.status };
  }
}

// Adapter contract: exactly one PID block per authMode. Surface as
// a 422 instead of letting the adapter reject it downstream — the
// frontend gets a precise field error to bind to the right input.
function assertOnePidPerMode(body: BiometricVerifyRequest): void {
  const expected =
    body.authMode === 'FINGERPRINT'
      ? 'fingerPrintAuthPid'
      : body.authMode === 'FACE_AUTH'
        ? 'faceAuthPid'
        : 'irisAuthPid';
  const present = (
    ['fingerPrintAuthPid', 'faceAuthPid', 'irisAuthPid'] as const
  ).filter((k) => body.authData[k] !== undefined);
  if (present.length !== 1 || present[0] !== expected) {
    throw new ValidationFailedError({
      authData: [
        `authMode=${body.authMode} requires exactly the matching PID block (${expected}).`,
      ],
    });
  }
}
