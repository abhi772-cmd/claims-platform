import {
  type AssignClaimRequest,
  AssignClaimRequestSchema,
  type ClaimEventListResponse,
  type ManualTransitionRequest,
  ManualTransitionRequestSchema,
  Permissions,
} from '@claims/contracts';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Request } from 'express';

import { CaseService } from './case.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClaimService } from '../claim';

// /cases/:caseId/claims/:claimId — read + manual transition. Real
// transitions come from the rail adapters (NHCX / PMJAY) in later
// slices; this exposes the event timeline + an admin escape hatch
// gated by case.assign for ops use.
@ApiTags('claims')
@Controller('cases/:caseId/claims/:claimId')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ClaimController {
  constructor(
    private readonly claims: ClaimService,
    private readonly cases: CaseService,
  ) {}

  @Get('events')
  @RequirePermission(Permissions.CASE_VIEW)
  async listEvents(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<ClaimEventListResponse> {
    // Verify the claim actually belongs to the case (and the tenant —
    // RLS catches the cross-tenant case but we want a clean 404, not
    // an empty list).
    const detail = await this.cases.getById(user.tenantId, caseId);
    const owns = detail.claims.some((c) => c.id === claimId);
    if (!owns) throw new ValidationFailedError({ claimId: ['Claim not on this case.'] });

    const events = await this.claims.listEvents(user.tenantId, claimId);
    return {
      events: events.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        resultingStatus: e.resultingStatus,
        occurredAt: e.occurredAt.toISOString(),
        recordedAt: e.recordedAt.toISOString(),
        recordedById: e.recordedById,
        payload: e.payload,
      })),
    };
  }

  // Tier 2 — assign / unassign a claim to a tenant user.
  // userId === null clears the assignment. Gated on case.assign
  // (existing permission, already in the seed). Writes a
  // `claim.assigned` event so the audit trail captures the change.
  @Post('assign')
  @HttpCode(200)
  @RequirePermission(Permissions.CASE_ASSIGN)
  async assign(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body(new ZodValidationPipe(AssignClaimRequestSchema))
    body: AssignClaimRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<{ assignedToUserId: string | null }> {
    const detail = await this.cases.getById(user.tenantId, caseId);
    const owns = detail.claims.some((c) => c.id === claimId);
    if (!owns) throw new ValidationFailedError({ claimId: ['Claim not on this case.'] });
    const out = await this.claims.assign({
      tenantId: user.tenantId,
      claimId,
      userId: body.userId,
      actorUserId: user.userId,
    });
    return { assignedToUserId: out.assignedToUserId ?? null };
  }

  @Post('transitions')
  @HttpCode(200)
  @RequirePermission(Permissions.CASE_ASSIGN)
  async manualTransition(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body(new ZodValidationPipe(ManualTransitionRequestSchema))
    body: ManualTransitionRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
    @Req() req: Request,
  ): Promise<{ status: string }> {
    void req;
    const detail = await this.cases.getById(user.tenantId, caseId);
    const owns = detail.claims.some((c) => c.id === claimId);
    if (!owns) throw new ValidationFailedError({ claimId: ['Claim not on this case.'] });

    const out = await this.claims.transition({
      tenantId: user.tenantId,
      claimId,
      eventType: body.eventType,
      actorUserId: user.userId,
      ...(body.payload !== undefined ? { payload: body.payload } : {}),
      ...(body.patch !== undefined ? { patch: body.patch } : {}),
    });
    return { status: out.status };
  }
}
