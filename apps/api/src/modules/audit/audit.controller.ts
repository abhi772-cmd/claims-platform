import {
  type AuditLogEntry,
  type AuditLogFilter,
  AuditLogFilterSchema,
  type AuditLogListResponse,
  Permissions,
} from '@claims/contracts';
import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Response } from 'express';
import { z } from 'zod';

import { AuditService, type AuditListedRow } from './audit.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

const ListQuerySchema = AuditLogFilterSchema.extend({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const ExportQuerySchema = AuditLogFilterSchema;

@ApiTags('audit')
@Controller('audit')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermission(Permissions.AUDIT_VIEW)
  async list(
    @Query(new ZodValidationPipe(ListQuerySchema))
    q: AuditLogFilter & { limit?: number; offset?: number },
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<AuditLogListResponse> {
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    const { rows, total } = await this.audit.list({
      tenantId: user.tenantId,
      limit,
      offset,
      ...(q.from !== undefined ? { from: new Date(q.from) } : {}),
      ...(q.to !== undefined ? { to: new Date(q.to) } : {}),
      ...(q.action !== undefined ? { action: q.action } : {}),
      ...(q.resourceType !== undefined ? { resourceType: q.resourceType } : {}),
      ...(q.resourceId !== undefined ? { resourceId: q.resourceId } : {}),
      ...(q.actorUserId !== undefined ? { actorUserId: q.actorUserId } : {}),
      ...(q.correlationId !== undefined ? { correlationId: q.correlationId } : {}),
    });
    return {
      entries: rows.map(toEntry),
      total,
      limit,
      offset,
    };
  }

  // Streaming CSV export. We pipe rows from the generator straight to
  // the response so memory stays bounded regardless of result size.
  // Capped at 100k rows server-side; operators above that should
  // narrow the filter or ask for a paginated dump.
  @Get('export.csv')
  @RequirePermission(Permissions.AUDIT_VIEW)
  async export(
    @Query(new ZodValidationPipe(ExportQuerySchema)) q: AuditLogFilter,
    @CurrentUser() user: Express.AuthenticatedUser,
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader(
      'content-disposition',
      `attachment; filename="audit-${user.tenantId.slice(0, 8)}-${Date.now()}.csv"`,
    );
    res.write(CSV_HEADER + '\n');
    for await (const row of this.audit.streamForExport({
      tenantId: user.tenantId,
      ...(q.from !== undefined ? { from: new Date(q.from) } : {}),
      ...(q.to !== undefined ? { to: new Date(q.to) } : {}),
      ...(q.action !== undefined ? { action: q.action } : {}),
      ...(q.resourceType !== undefined ? { resourceType: q.resourceType } : {}),
      ...(q.resourceId !== undefined ? { resourceId: q.resourceId } : {}),
      ...(q.actorUserId !== undefined ? { actorUserId: q.actorUserId } : {}),
      ...(q.correlationId !== undefined ? { correlationId: q.correlationId } : {}),
    })) {
      res.write(toCsvLine(row) + '\n');
    }
    res.end();
  }
}

function toEntry(row: AuditListedRow): AuditLogEntry {
  return {
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    actorUserId: row.actorUserId,
    actorType: row.actorType as AuditLogEntry['actorType'],
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    before: row.before ?? null,
    after: row.after ?? null,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    correlationId: row.correlationId,
  };
}

const CSV_HEADER = [
  'id',
  'occurredAt',
  'actorUserId',
  'actorType',
  'action',
  'resourceType',
  'resourceId',
  'ipAddress',
  'userAgent',
  'correlationId',
  'beforeJson',
  'afterJson',
].join(',');

// RFC 4180-ish CSV escape: wrap in quotes, double any embedded quote.
// Newlines inside the JSON columns are also handled by the wrapping.
function csvCell(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  const needsQuoting = /[",\n\r]/.test(value);
  if (!needsQuoting) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function toCsvLine(row: AuditListedRow): string {
  return [
    row.id,
    row.occurredAt.toISOString(),
    row.actorUserId ?? '',
    row.actorType,
    row.action,
    row.resourceType,
    row.resourceId ?? '',
    row.ipAddress ?? '',
    row.userAgent ?? '',
    row.correlationId ?? '',
    csvCell(row.before === null || row.before === undefined ? null : JSON.stringify(row.before)),
    csvCell(row.after === null || row.after === undefined ? null : JSON.stringify(row.after)),
  ]
    .map((c, i) => (i < 10 ? csvCell(c) : c))
    .join(',');
}
