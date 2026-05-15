import {
  type ListCommunicationsResponse,
  Permissions,
  type SendCommunicationRequest,
  SendCommunicationRequestSchema,
  type SendCommunicationResponse,
} from '@claims/contracts';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { CommunicationService } from './communication.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CaseService } from '../case';

// Stage 5 — hospital-initiated communication/request.
//
// POST /cases/:caseId/claims/:claimId/communications
//   Free-form proactive message to the payer. Body: { text,
//   inReplyToCorrelationId? }. Returns { correlationId, sentAt }.
//
// GET /cases/:caseId/communications
//   Case-level timeline across ALL claims on the case. Returns both
//   outbound (hospital-sent) and inbound (payer-initiated) entries
//   sorted by occurredAt asc.

@ApiTags('communication')
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class CommunicationController {
  constructor(
    private readonly comms: CommunicationService,
    private readonly cases: CaseService,
  ) {}

  @Post('cases/:caseId/claims/:claimId/communications')
  @HttpCode(200)
  @RequirePermission(Permissions.COMMUNICATION_SEND)
  async send(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body(new ZodValidationPipe(SendCommunicationRequestSchema))
    body: SendCommunicationRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<SendCommunicationResponse> {
    await this.assertOwns(user.tenantId, caseId, claimId);
    return this.comms.sendOutbound({
      tenantId: user.tenantId,
      claimId,
      actorUserId: user.userId,
      text: body.text,
      ...(body.inReplyToCorrelationId !== undefined
        ? { inReplyToCorrelationId: body.inReplyToCorrelationId }
        : {}),
    });
  }

  @Get('cases/:caseId/communications')
  @RequirePermission(Permissions.COMMUNICATION_VIEW)
  async list(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<ListCommunicationsResponse> {
    // Authorise via case ownership; service handles the actual
    // tenant-scoped query.
    await this.cases.getById(user.tenantId, caseId);
    return this.comms.listForCase(user.tenantId, caseId);
  }

  private async assertOwns(tenantId: string, caseId: string, claimId: string): Promise<void> {
    const detail = await this.cases.getById(tenantId, caseId);
    const owns = detail.claims.some((c) => c.id === claimId);
    if (!owns) throw new ValidationFailedError({ claimId: ['Claim not on this case.'] });
  }
}
