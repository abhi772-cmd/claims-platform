import {
  type PayerCommercialTerms,
  type PayerCommercialTermsListResponse,
  type PayerOnboardingStatusResponse,
  Permissions,
  UpsertPayerCommercialTermsRequestSchema,
} from '@claims/contracts';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { PayerCommercialTermsService } from './payer-commercial-terms.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('payer-commercial-terms')
@Controller('admin/payer-commercial-terms')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PayerCommercialTermsController {
  constructor(private readonly service: PayerCommercialTermsService) {}

  // List every keyed row + mandatory-complete flag. Used by the
  // onboarding step page to render the per-payer table.
  @Get()
  @RequirePermission(Permissions.TENANT_ONBOARDING_UPDATE)
  async list(
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<PayerCommercialTermsListResponse> {
    const terms = await this.service.list(user.tenantId);
    return { terms };
  }

  // Aggregate completeness across every active payer × the room rate
  // catalog. Drives the onboarding page's status table.
  @Get('status')
  @RequirePermission(Permissions.TENANT_ONBOARDING_UPDATE)
  async status(
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<PayerOnboardingStatusResponse> {
    return this.service.listOnboardingStatus(user.tenantId);
  }

  @Get(':payerCode')
  @RequirePermission(Permissions.TENANT_ONBOARDING_UPDATE)
  async get(
    @CurrentUser() user: Express.AuthenticatedUser,
    @Param('payerCode') payerCode: string,
  ): Promise<PayerCommercialTerms> {
    const row = await this.service.getByPayerCode(user.tenantId, payerCode);
    if (!row) throw new NotFoundException('Commercial terms not found for this payer.');
    return row;
  }

  // Upsert by (tenantId, payerCode). PUT because the operation is
  // idempotent and the natural key is in the body.
  @Put()
  @RequirePermission(Permissions.TENANT_ONBOARDING_UPDATE)
  async upsert(
    @CurrentUser() user: Express.AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<PayerCommercialTerms> {
    const parsed = UpsertPayerCommercialTermsRequestSchema.safeParse(body);
    if (!parsed.success) {
      const out: Record<string, string[]> = {};
      for (const i of parsed.error.issues) {
        const key = i.path.join('.') || '_';
        (out[key] ??= []).push(i.message);
      }
      throw new ValidationFailedError(out);
    }
    return this.service.upsert(user.tenantId, parsed.data);
  }

  @Delete(':payerCode')
  @HttpCode(204)
  @RequirePermission(Permissions.TENANT_ONBOARDING_UPDATE)
  async deactivate(
    @CurrentUser() user: Express.AuthenticatedUser,
    @Param('payerCode') payerCode: string,
  ): Promise<void> {
    await this.service.deactivate(user.tenantId, payerCode);
  }
}
