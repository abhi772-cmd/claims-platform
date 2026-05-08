// Slice BQ — DPDP §11 erasure-on-request endpoints.

import {
  type ErasureRequestRow as ErasureRequestRowContract,
  type FileErasureRequest,
  FileErasureRequestSchema,
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
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ErasureRequestService } from './erasure-request.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('erasure-requests')
@Controller('erasure-requests')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ErasureRequestController {
  constructor(private readonly service: ErasureRequestService) {}

  // File + process synchronously. Returns either 'completed' (PII
  // redacted) or 'rejected' (one or more claims still active). The
  // operator decides whether to retry once the blocking claims
  // close.
  @Post()
  @HttpCode(200)
  @RequirePermission(Permissions.ERASURE_PROCESS)
  async file(
    @Body(new ZodValidationPipe(FileErasureRequestSchema)) body: FileErasureRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<ErasureRequestRowContract> {
    const row = await this.service.fileAndProcess({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      patientId: body.patientId,
      requestedBy: body.requestedBy,
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
    });
    return rowToContract(row);
  }

  @Get(':id')
  @RequirePermission(Permissions.ERASURE_PROCESS)
  async findById(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<ErasureRequestRowContract> {
    const row = await this.service.findById(user.tenantId, id);
    if (!row) throw new ValidationFailedError({ id: ['Erasure request not found.'] });
    return rowToContract(row);
  }
}

function rowToContract(row: {
  id: string;
  tenantId: string;
  patientId: string | null;
  requestedBy: string;
  reason: string | null;
  status: 'completed' | 'rejected';
  rejectionReason: { blockingClaims: Array<{ id: string; status: string }> } | null;
  affectedCounts: { patient: number; case: number } | null;
  processedByUserId: string | null;
  createdAt: Date;
  completedAt: Date | null;
}): ErasureRequestRowContract {
  return {
    id: row.id,
    tenantId: row.tenantId,
    patientId: row.patientId,
    requestedBy: row.requestedBy,
    reason: row.reason,
    status: row.status,
    rejectionReason: row.rejectionReason,
    affectedCounts: row.affectedCounts,
    processedByUserId: row.processedByUserId,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}
