import {
  type CompleteOnboardingStepRequest,
  CompleteOnboardingStepRequestSchema,
  type LifecycleStateResponse,
  type LifecycleTransitionRequest,
  LifecycleTransitionRequestSchema,
  type OnboardingStep,
  type OnboardingStepKey,
  OnboardingStepKeySchema,
  type OnboardingStepsResponse,
  Permissions,
  type ReadinessReport,
  type TenantProfile,
  type TenantProfileUpdate,
  TenantProfileUpdateSchema,
} from '@claims/contracts';
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Request } from 'express';

import { OnboardingService } from './onboarding.service';
import { ReadinessService } from './readiness.service';
import { TenantLifecycleService } from './tenant-lifecycle.service';
import { TenantProfileService } from './tenant-profile.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('tenant-onboarding')
@Controller('tenant')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OnboardingController {
  constructor(
    private readonly onboarding: OnboardingService,
    private readonly readiness: ReadinessService,
    private readonly lifecycle: TenantLifecycleService,
    private readonly profile: TenantProfileService,
  ) {}

  // -- Tenant profile (Stage-1 onboarding fields) --

  @Get('profile')
  @RequirePermission(Permissions.TENANT_ONBOARDING_UPDATE)
  async getProfile(
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<TenantProfile> {
    return this.profile.get(user.tenantId);
  }

  @Patch('profile')
  @RequirePermission(Permissions.TENANT_ONBOARDING_UPDATE)
  async patchProfile(
    @Body(new ZodValidationPipe(TenantProfileUpdateSchema)) body: TenantProfileUpdate,
    @CurrentUser() user: Express.AuthenticatedUser,
    @Req() req: Request,
  ): Promise<TenantProfile> {
    return this.profile.update({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      patch: body,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
  }

  // -- Onboarding wizard --

  @Get('onboarding/steps')
  @RequirePermission(Permissions.TENANT_ONBOARDING_UPDATE)
  async listSteps(
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<OnboardingStepsResponse> {
    const steps = await this.onboarding.list(user.tenantId);
    return { steps };
  }

  @Post('onboarding/steps/:key/complete')
  @HttpCode(200)
  @RequirePermission(Permissions.TENANT_ONBOARDING_UPDATE)
  async completeStep(
    @Param('key') keyRaw: string,
    @Body(new ZodValidationPipe(CompleteOnboardingStepRequestSchema))
    body: CompleteOnboardingStepRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
    @Req() req: Request,
  ): Promise<OnboardingStep> {
    const parsedKey = OnboardingStepKeySchema.safeParse(keyRaw);
    if (!parsedKey.success) {
      throw new ValidationFailedError({ key: ['Unknown step key.'] });
    }
    const key: OnboardingStepKey = parsedKey.data;
    return this.onboarding.complete({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      stepKey: key,
      status: body.status ?? 'completed',
      evidence: body.evidence ?? {},
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
  }

  // -- Readiness --

  @Get('readiness')
  @RequirePermission(Permissions.TENANT_ONBOARDING_UPDATE)
  async runReadiness(
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<ReadinessReport> {
    return this.readiness.run(user.tenantId);
  }

  // -- Lifecycle --

  @Get('lifecycle')
  @RequirePermission(Permissions.TENANT_LIFECYCLE_TRANSITION)
  async lifecycleState(
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<LifecycleStateResponse> {
    const out = await this.lifecycle.getState(user.tenantId);
    return { state: out.state, allowedTargets: [...out.allowedTargets] };
  }

  @Post('lifecycle/transition')
  @HttpCode(200)
  @RequirePermission(Permissions.TENANT_LIFECYCLE_TRANSITION)
  async lifecycleTransition(
    @Body(new ZodValidationPipe(LifecycleTransitionRequestSchema))
    body: LifecycleTransitionRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
    @Req() req: Request,
  ): Promise<LifecycleStateResponse> {
    const out = await this.lifecycle.transition({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      target: body.target,
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    return { state: out.state, allowedTargets: [...out.allowedTargets] };
  }
}
