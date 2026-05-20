// Slice BT — DPDP §6 / Rule 8 consent record endpoints.
//
// Routes:
//   POST   /consents               — manage; capture a new grant
//   GET    /consents               — view; list (filter by patient / type / status)
//   GET    /consents/:id           — view; row + active flag
//   POST   /consents/:id/withdraw  — manage; flip granted → withdrawn with reason

import {
  type ConsentListFilter,
  ConsentListFilterSchema,
  type ConsentListResponse,
  type ConsentRecordRow,
  type GrantConsent,
  GrantConsentSchema,
  Permissions,
  type WithdrawConsent,
  WithdrawConsentSchema,
} from '@claims/contracts';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ConsentService } from './consent.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('consents')
@Controller('consents')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ConsentController {
  constructor(private readonly service: ConsentService) {}

  @Post()
  @HttpCode(200)
  @RequirePermission(Permissions.CONSENT_MANAGE)
  async grant(
    @Body(new ZodValidationPipe(GrantConsentSchema)) body: GrantConsent,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<ConsentRecordRow> {
    return this.service.grant({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      patientId: body.patientId,
      consentType: body.consentType,
      dataCategories: body.dataCategories,
      purposes: body.purposes,
      lawfulBasis: body.lawfulBasis,
      source: body.source,
      evidence: body.evidence,
      ...(body.expiresAt ? { expiresAt: new Date(body.expiresAt) } : {}),
      ...(body.documentId ? { documentId: body.documentId } : {}),
      ...(body.acknowledgementMethod
        ? { acknowledgementMethod: body.acknowledgementMethod }
        : {}),
      ...(body.acknowledgementRef ? { acknowledgementRef: body.acknowledgementRef } : {}),
    });
  }

  @Get()
  @RequirePermission(Permissions.CONSENT_VIEW)
  async list(
    @Query(new ZodValidationPipe(ConsentListFilterSchema)) q: ConsentListFilter,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<ConsentListResponse> {
    const { rows, total } = await this.service.list({
      tenantId: user.tenantId,
      ...(q.patientId ? { patientId: q.patientId } : {}),
      ...(q.consentType ? { consentType: q.consentType } : {}),
      ...(q.status ? { status: q.status } : {}),
    });
    return { rows, total };
  }

  @Get(':id')
  @RequirePermission(Permissions.CONSENT_VIEW)
  async findById(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<ConsentRecordRow> {
    const row = await this.service.findById(user.tenantId, id);
    if (!row) throw new ValidationFailedError({ id: ['Consent record not found.'] });
    return row;
  }

  @Post(':id/withdraw')
  @HttpCode(200)
  @RequirePermission(Permissions.CONSENT_MANAGE)
  async withdraw(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(WithdrawConsentSchema)) body: WithdrawConsent,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<ConsentRecordRow> {
    return this.service.withdraw({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      consentId: id,
      reason: body.reason,
    });
  }
}
