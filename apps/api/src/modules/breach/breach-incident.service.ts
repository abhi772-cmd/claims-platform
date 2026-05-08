// Slice BS — DPDP §8(6) breach incident service.
//
// Handles the lifecycle of a breach_incident row: open (manual file or
// detector call), list / get, notify, dismiss. The detector lives in
// a sibling service (breach-detector.service.ts) and calls openWithTx
// from inside its scan transaction so insert + scan-completion audit
// commit atomically.
//
// State machine:
//   detected → notified
//   detected → dismissed
//   detected → resolved   (reserved for future use; not exposed in v1)
//
// All other transitions throw a domain error. The RLS UPDATE policy
// allows tenant-scoped flips, so the legal sequencing is enforced by
// this service, not the database.

import {
  type BreachIncidentRow,
  type BreachKind,
  type BreachSeverity,
  type DpdpNotificationPayload,
} from '@claims/contracts';
import { Injectable } from '@nestjs/common';


import {
  DPDP_NOTIFICATION_WINDOW_MS,
  renderDpdpNotification,
} from './dpdp-notification-template';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { type TenantPrisma } from '../../types/express';
import { AuditEvents } from '../audit/audit.events';
import { AuditService } from '../audit/audit.service';

export interface FileManualBreachInput {
  tenantId: string;
  actorUserId: string;
  severity: BreachSeverity;
  description: string;
  dataCategories: string[];
  affectedDataPrincipals: number;
}

// Used by BreachDetectorService for auto-detected rows.
export interface OpenAutoBreachInput {
  tenantId: string;
  kind: Exclude<BreachKind, 'MANUAL_REPORT'>;
  severity: BreachSeverity;
  actorUserId: string;
  affectedDataPrincipals: number;
  dataCategories: string[];
  description: string;
  evidenceEventIds: string[];
  windowStart: Date;
  windowEnd: Date;
}

export interface ListInput {
  tenantId: string;
  status?: string;
  kind?: string;
  from?: Date;
  to?: Date;
}

@Injectable()
export class BreachIncidentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // Operator-filed manual breach. Always lands kind='MANUAL_REPORT'
  // with actorUserId/windowStart left null (skips the detector's
  // dedup unique constraint — multiple manual rows per tenant are
  // intentionally allowed).
  async fileManual(input: FileManualBreachInput): Promise<BreachIncidentRow> {
    return this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      const now = new Date();
      const dueAt = new Date(now.getTime() + DPDP_NOTIFICATION_WINDOW_MS);
      const row = await tx.breachIncident.create({
        data: {
          tenantId: input.tenantId,
          kind: 'MANUAL_REPORT',
          severity: input.severity,
          status: 'detected',
          actorUserId: null,
          affectedDataPrincipals: input.affectedDataPrincipals,
          dataCategories: input.dataCategories,
          description: input.description,
          evidenceEventIds: [],
          windowStart: null,
          windowEnd: null,
          openedAt: now,
          dpdpNotificationDueAt: dueAt,
        },
      });
      await this.audit.recordWithTx(tx, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        actorType: 'user',
        action: AuditEvents.BREACH_INCIDENT_OPENED,
        resourceType: 'breach_incident',
        resourceId: row.id,
        after: {
          kind: row.kind,
          severity: row.severity,
          affectedDataPrincipals: row.affectedDataPrincipals,
        },
      });
      return rowToShape(row);
    });
  }

  // Auto-detection path. Called by BreachDetectorService inside its
  // scan transaction. Returns null if a row already exists for the
  // (tenantId, kind, actorUserId, windowStart) tuple — that's the
  // detector's idempotency.
  async openAutoWithTx(
    tx: TenantPrisma,
    input: OpenAutoBreachInput,
  ): Promise<BreachIncidentRow | null> {
    const existing = await tx.breachIncident.findUnique({
      where: {
        tenantId_kind_actorUserId_windowStart: {
          tenantId: input.tenantId,
          kind: input.kind,
          actorUserId: input.actorUserId,
          windowStart: input.windowStart,
        },
      },
    });
    if (existing) return null;

    const dueAt = new Date(input.windowEnd.getTime() + DPDP_NOTIFICATION_WINDOW_MS);
    const row = await tx.breachIncident.create({
      data: {
        tenantId: input.tenantId,
        kind: input.kind,
        severity: input.severity,
        status: 'detected',
        actorUserId: input.actorUserId,
        affectedDataPrincipals: input.affectedDataPrincipals,
        dataCategories: input.dataCategories,
        description: input.description,
        evidenceEventIds: input.evidenceEventIds,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        openedAt: input.windowEnd,
        dpdpNotificationDueAt: dueAt,
      },
    });
    await this.audit.recordWithTx(tx, {
      tenantId: input.tenantId,
      actorUserId: null,
      actorType: 'system',
      action: AuditEvents.BREACH_INCIDENT_OPENED,
      resourceType: 'breach_incident',
      resourceId: row.id,
      after: {
        kind: row.kind,
        severity: row.severity,
        actorUserId: row.actorUserId,
        affectedDataPrincipals: row.affectedDataPrincipals,
        evidenceCount: input.evidenceEventIds.length,
      },
    });
    return rowToShape(row);
  }

  async list(input: ListInput): Promise<{ rows: BreachIncidentRow[]; total: number }> {
    return this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      const where = {
        tenantId: input.tenantId,
        ...(input.status ? { status: input.status } : {}),
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.from || input.to
          ? {
              openedAt: {
                ...(input.from ? { gte: input.from } : {}),
                ...(input.to ? { lt: input.to } : {}),
              },
            }
          : {}),
      };
      const [rows, total] = await Promise.all([
        tx.breachIncident.findMany({ where, orderBy: { openedAt: 'desc' }, take: 200 }),
        tx.breachIncident.count({ where }),
      ]);
      return { rows: rows.map(rowToShape), total };
    });
  }

  async findById(tenantId: string, id: string): Promise<BreachIncidentRow | null> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const row = await tx.breachIncident.findUnique({ where: { id } });
      if (!row || row.tenantId !== tenantId) return null;
      return rowToShape(row);
    });
  }

  // Render the §8(6) notification template for an incident — read-only
  // preview before notify. Operators see this on the incident detail
  // page so they can verify what would be submitted.
  async renderNotificationPreview(
    tenantId: string,
    id: string,
    grievanceOfficerContact: string | null,
  ): Promise<DpdpNotificationPayload | null> {
    const incident = await this.findById(tenantId, id);
    if (!incident) return null;
    const tenant = await this.prisma.runInTenantContext(tenantId, 'tenant', (tx) =>
      tx.tenant.findUnique({
        where: { id: tenantId },
        select: { slug: true, displayName: true },
      }),
    );
    if (!tenant) return null;
    return renderDpdpNotification({
      incidentId: incident.id,
      tenantSlug: tenant.slug,
      tenantDisplayName: tenant.displayName,
      grievanceOfficerContact,
      kind: incident.kind,
      severity: incident.severity,
      openedAt: new Date(incident.openedAt),
      dueAt: new Date(incident.dpdpNotificationDueAt),
      description: incident.description,
      affectedDataPrincipals: incident.affectedDataPrincipals,
      dataCategories: incident.dataCategories,
    });
  }

  // Mark the incident as notified — capture the rendered template
  // payload as the snapshot of what was sent. Caller passes the
  // grievance-officer contact (the controller resolves it from
  // request context; v1 falls back to a placeholder when absent).
  async notify(
    tenantId: string,
    id: string,
    actorUserId: string,
    grievanceOfficerContact: string | null,
  ): Promise<BreachIncidentRow> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const existing = await tx.breachIncident.findUnique({ where: { id } });
      if (!existing || existing.tenantId !== tenantId) {
        throw new ValidationFailedError({ id: ['Breach incident not found.'] });
      }
      if (existing.status !== 'detected') {
        throw new ValidationFailedError({
          status: [
            `Cannot notify from status='${existing.status}'. Only 'detected' incidents can be notified.`,
          ],
        });
      }
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { slug: true, displayName: true },
      });
      if (!tenant) {
        throw new ValidationFailedError({ tenantId: ['Tenant not found.'] });
      }
      const payload = renderDpdpNotification({
        incidentId: existing.id,
        tenantSlug: tenant.slug,
        tenantDisplayName: tenant.displayName,
        grievanceOfficerContact,
        kind: existing.kind as BreachKind,
        severity: existing.severity as BreachSeverity,
        openedAt: existing.openedAt,
        dueAt: existing.dpdpNotificationDueAt,
        description: existing.description,
        affectedDataPrincipals: existing.affectedDataPrincipals,
        dataCategories: existing.dataCategories as string[],
      });
      const row = await tx.breachIncident.update({
        where: { id },
        data: {
          status: 'notified',
          dpdpNotificationSentAt: new Date(),
          dpdpNotificationPayload: payload as unknown as object,
          processedByUserId: actorUserId,
        },
      });
      await this.audit.recordWithTx(tx, {
        tenantId,
        actorUserId,
        actorType: 'user',
        action: AuditEvents.BREACH_INCIDENT_NOTIFIED,
        resourceType: 'breach_incident',
        resourceId: row.id,
        after: { sentAt: row.dpdpNotificationSentAt },
      });
      return rowToShape(row);
    });
  }

  async dismiss(
    tenantId: string,
    id: string,
    actorUserId: string,
    reason: string,
  ): Promise<BreachIncidentRow> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const existing = await tx.breachIncident.findUnique({ where: { id } });
      if (!existing || existing.tenantId !== tenantId) {
        throw new ValidationFailedError({ id: ['Breach incident not found.'] });
      }
      if (existing.status !== 'detected') {
        throw new ValidationFailedError({
          status: [
            `Cannot dismiss from status='${existing.status}'. Only 'detected' incidents can be dismissed.`,
          ],
        });
      }
      const row = await tx.breachIncident.update({
        where: { id },
        data: {
          status: 'dismissed',
          dismissalReason: reason,
          processedByUserId: actorUserId,
        },
      });
      await this.audit.recordWithTx(tx, {
        tenantId,
        actorUserId,
        actorType: 'user',
        action: AuditEvents.BREACH_INCIDENT_DISMISSED,
        resourceType: 'breach_incident',
        resourceId: row.id,
        after: { reason },
      });
      return rowToShape(row);
    });
  }
}

// Convert the Prisma row into the wire shape (Date → ISO, JSON →
// typed arrays). Centralised so service callers don't have to repeat
// the conversion.
function rowToShape(row: {
  id: string;
  tenantId: string;
  kind: string;
  severity: string;
  status: string;
  actorUserId: string | null;
  affectedDataPrincipals: number;
  dataCategories: unknown;
  description: string;
  evidenceEventIds: unknown;
  windowStart: Date | null;
  windowEnd: Date | null;
  openedAt: Date;
  dpdpNotificationDueAt: Date;
  dpdpNotificationSentAt: Date | null;
  dpdpNotificationPayload: unknown;
  dismissalReason: string | null;
  processedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): BreachIncidentRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    kind: row.kind as BreachIncidentRow['kind'],
    severity: row.severity as BreachIncidentRow['severity'],
    status: row.status as BreachIncidentRow['status'],
    actorUserId: row.actorUserId,
    affectedDataPrincipals: row.affectedDataPrincipals,
    dataCategories: (row.dataCategories as string[]) ?? [],
    description: row.description,
    evidenceEventIds: (row.evidenceEventIds as string[]) ?? [],
    windowStart: row.windowStart?.toISOString() ?? null,
    windowEnd: row.windowEnd?.toISOString() ?? null,
    openedAt: row.openedAt.toISOString(),
    dpdpNotificationDueAt: row.dpdpNotificationDueAt.toISOString(),
    dpdpNotificationSentAt: row.dpdpNotificationSentAt?.toISOString() ?? null,
    dpdpNotificationPayload: (row.dpdpNotificationPayload as DpdpNotificationPayload | null) ?? null,
    dismissalReason: row.dismissalReason,
    processedByUserId: row.processedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
