// Slice BS — DPDP §8(6) breach incident endpoints.
//
// Routes:
//   POST   /breach-incidents/scan         — manage; trigger detector pass
//   POST   /breach-incidents              — manage; manual file
//   GET    /breach-incidents              — view; list (filter by status / kind / date)
//   GET    /breach-incidents/:id          — view; row + rendered preview
//   POST   /breach-incidents/:id/notify   — manage; flip to notified, snapshot template
//   POST   /breach-incidents/:id/dismiss  — manage; flip to dismissed with reason
//
// Auto-detection lives behind the scan endpoint + CLI; the controller
// path is the operator-facing knob. Detector also runs from
// `pnpm --filter @claims/api breach:scan` for cron-driven sweeps.

import {
  type BreachIncidentFilter,
  BreachIncidentFilterSchema,
  type BreachIncidentListResponse,
  type BreachIncidentRow,
  type BreachScanResult,
  type DismissBreachIncident,
  DismissBreachIncidentSchema,
  type DpdpNotificationPayload,
  type FileBreachIncident,
  FileBreachIncidentSchema,
  type NotifyBreachIncident,
  NotifyBreachIncidentSchema,
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
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { BreachDetectorService } from './breach-detector.service';
import { BreachIncidentService } from './breach-incident.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('breach-incidents')
@Controller('breach-incidents')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BreachIncidentController {
  constructor(
    private readonly incidents: BreachIncidentService,
    private readonly detector: BreachDetectorService,
  ) {}

  @Post('scan')
  @HttpCode(200)
  @RequirePermission(Permissions.BREACH_INCIDENT_MANAGE)
  async scan(): Promise<BreachScanResult> {
    return this.detector.scan();
  }

  @Post()
  @HttpCode(200)
  @RequirePermission(Permissions.BREACH_INCIDENT_MANAGE)
  async file(
    @Body(new ZodValidationPipe(FileBreachIncidentSchema)) body: FileBreachIncident,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<BreachIncidentRow> {
    return this.incidents.fileManual({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      severity: body.severity,
      description: body.description,
      dataCategories: body.dataCategories,
      affectedDataPrincipals: body.affectedDataPrincipals,
    });
  }

  @Get()
  @RequirePermission(Permissions.BREACH_INCIDENT_VIEW)
  async list(
    @Query(new ZodValidationPipe(BreachIncidentFilterSchema)) q: BreachIncidentFilter,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<BreachIncidentListResponse> {
    const { rows, total } = await this.incidents.list({
      tenantId: user.tenantId,
      ...(q.status ? { status: q.status } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.from ? { from: new Date(q.from) } : {}),
      ...(q.to ? { to: new Date(q.to) } : {}),
    });
    return { rows, total };
  }

  // Returns the row plus a rendered §8(6) preview when status is
  // 'detected'. Operators see what will be submitted before flipping
  // to 'notified'. The grievance-officer contact resolves to a
  // placeholder in v1 — Tenant doesn't carry the field yet; BU's
  // dashboard will add it on the tenant_security model.
  @Get(':id')
  @RequirePermission(Permissions.BREACH_INCIDENT_VIEW)
  async findById(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<{ incident: BreachIncidentRow; notificationPreview: DpdpNotificationPayload | null }> {
    const incident = await this.incidents.findById(user.tenantId, id);
    if (!incident) {
      throw new ValidationFailedError({ id: ['Breach incident not found.'] });
    }
    const preview =
      incident.status === 'detected'
        ? await this.incidents.renderNotificationPreview(user.tenantId, id, null)
        : incident.dpdpNotificationPayload;
    return { incident, notificationPreview: preview };
  }

  @Post(':id/notify')
  @HttpCode(200)
  @RequirePermission(Permissions.BREACH_INCIDENT_MANAGE)
  async notify(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(NotifyBreachIncidentSchema)) _body: NotifyBreachIncident,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<BreachIncidentRow> {
    return this.incidents.notify(user.tenantId, id, user.userId, null);
  }

  @Post(':id/dismiss')
  @HttpCode(200)
  @RequirePermission(Permissions.BREACH_INCIDENT_MANAGE)
  async dismiss(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(DismissBreachIncidentSchema)) body: DismissBreachIncident,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<BreachIncidentRow> {
    return this.incidents.dismiss(user.tenantId, id, user.userId, body.reason);
  }
}
