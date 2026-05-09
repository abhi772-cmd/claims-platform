// Slice BU — DPDP / IRDAI / RBI compliance dashboard service.
//
// Single tenant-scoped read that assembles every section of the
// dashboard in parallel. Each section is independently bounded so
// the query stays cheap on tenants with millions of rows. The
// service deliberately denormalises some computation (overdue
// flag, consent status lookup) at read time so the page renders
// without further round-trips.

import {
  type ComplianceDashboard,
  type ConsentStatusCounts,
  type DataAccessSummaryRow,
  type RetentionClassCount,
} from '@claims/contracts';
import { Injectable } from '@nestjs/common';


import { PrismaService } from '../../common/prisma/prisma.service';
import {
  ALL_RETENTION_CLASSES,
  RETENTION_FLOOR_DAYS,
} from '../audit/retention-classes';

const RECENT_LIMIT = 20;
const ERASURE_RECENT_LIMIT = 10;
const CONSENT_RECENT_LIMIT = 10;
// 90-day window for the erasure counts — broad enough to be useful
// for compliance review without dragging in years of history that
// the dashboard isn't equipped to render.
const ERASURE_WINDOW_DAYS = 90;

@Injectable()
export class ComplianceDashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async load(tenantId: string): Promise<ComplianceDashboard> {
    const now = new Date();

    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      // Run independent queries in parallel where Prisma + the
      // single tx connection allows. Prisma serialises within a
      // single tx, so this is sequential for safety — the
      // round-trips are still tight because everything runs over
      // one connection with the GUC already set.

      // 1. Retention classes — counts per class + past-floor counts.
      //    We compute past-floor as a separate count per class so we
      //    can issue them concurrently. Six classes → 12 queries
      //    here is fine; the audit_log indexes cover both axes.
      const retentionClasses: RetentionClassCount[] = [];
      for (const cls of ALL_RETENTION_CLASSES) {
        const cutoff = new Date(now.getTime() - RETENTION_FLOOR_DAYS[cls] * 24 * 60 * 60 * 1000);
        const [total, pastFloor] = await Promise.all([
          tx.auditLog.count({ where: { tenantId, retentionClass: cls } }),
          tx.auditLog.count({
            where: { tenantId, retentionClass: cls, occurredAt: { lt: cutoff } },
          }),
        ]);
        retentionClasses.push({ retentionClass: cls, total, pastFloor });
      }

      // 2. Recent erasures + counts in the past 90 days.
      const erasureCutoff = new Date(now.getTime() - ERASURE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const [recentErasureRows, erasureCompleted, erasureRejected] = await Promise.all([
        tx.erasureRequest.findMany({
          where: { tenantId },
          orderBy: { createdAt: 'desc' },
          take: ERASURE_RECENT_LIMIT,
        }),
        tx.erasureRequest.count({
          where: { tenantId, status: 'completed', createdAt: { gte: erasureCutoff } },
        }),
        tx.erasureRequest.count({
          where: { tenantId, status: 'rejected', createdAt: { gte: erasureCutoff } },
        }),
      ]);
      const recentErasures = recentErasureRows.map((r) => ({
        id: r.id,
        status: r.status as 'completed' | 'rejected',
        patientId: r.patientId,
        blockingClaimsCount: countBlockingClaims(r.rejectionReason),
        createdAt: r.createdAt.toISOString(),
        completedAt: r.completedAt?.toISOString() ?? null,
      }));

      // 3. Recent data access — last N decrypt events for the
      //    tenant, joined to the bound consent record so the
      //    operator can see "this read was authorised by grant X
      //    which is currently 'granted'/'withdrawn'/etc.".
      const recentEvents = await tx.dataAccessEvent.findMany({
        where: { tenantId, action: 'decrypt' },
        orderBy: { occurredAt: 'desc' },
        take: RECENT_LIMIT,
      });
      const consentIds = recentEvents
        .map((e) => e.consentGrantId)
        .filter((id): id is string => id !== null);
      const consentMap = new Map<string, string>();
      if (consentIds.length > 0) {
        const consents = await tx.consentRecord.findMany({
          where: { tenantId, id: { in: consentIds } },
          select: { id: true, status: true },
        });
        for (const c of consents) consentMap.set(c.id, c.status);
      }
      const recentDataAccess: DataAccessSummaryRow[] = recentEvents.map((e) => {
        const status = e.consentGrantId
          ? (consentMap.get(e.consentGrantId) ?? 'unbound')
          : 'unbound';
        return {
          id: e.id,
          occurredAt: e.occurredAt.toISOString(),
          actorUserId: e.actorUserId,
          actorType: e.actorType,
          action: e.action,
          resourceType: e.resourceType,
          resourceId: e.resourceId,
          purpose: e.purpose,
          fieldNames: Array.isArray(e.fieldNames) ? (e.fieldNames as string[]) : null,
          consentGrantId: e.consentGrantId,
          consentStatus: status as DataAccessSummaryRow['consentStatus'],
        };
      });

      // Unbound access count in past 24h — engineering triage signal.
      const unboundCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const unboundAccessCountLast24h = await tx.dataAccessEvent.count({
        where: {
          tenantId,
          action: 'decrypt',
          consentGrantId: null,
          occurredAt: { gte: unboundCutoff },
        },
      });

      // 4. Breach incidents — counts per status + open list with overdue flag.
      const [breachDetected, breachNotified, breachDismissed, breachResolved, openBreachRows] =
        await Promise.all([
          tx.breachIncident.count({ where: { tenantId, status: 'detected' } }),
          tx.breachIncident.count({ where: { tenantId, status: 'notified' } }),
          tx.breachIncident.count({ where: { tenantId, status: 'dismissed' } }),
          tx.breachIncident.count({ where: { tenantId, status: 'resolved' } }),
          tx.breachIncident.findMany({
            where: { tenantId, status: 'detected' },
            orderBy: { dpdpNotificationDueAt: 'asc' },
            take: RECENT_LIMIT,
          }),
        ]);
      const openBreaches = openBreachRows.map((b) => ({
        id: b.id,
        kind: b.kind as 'BURST_DECRYPT' | 'MANUAL_REPORT',
        severity: b.severity as 'low' | 'medium' | 'high' | 'critical',
        status: b.status as 'detected' | 'notified' | 'dismissed' | 'resolved',
        affectedDataPrincipals: b.affectedDataPrincipals,
        openedAt: b.openedAt.toISOString(),
        dpdpNotificationDueAt: b.dpdpNotificationDueAt.toISOString(),
        overdue: b.dpdpNotificationDueAt.getTime() < now.getTime(),
      }));

      // 5. Consent — counts per status + most recent N rows
      //    (any state — the operator sees both fresh grants and
      //    fresh withdrawals).
      const consentCountsRaw = await Promise.all([
        tx.consentRecord.count({ where: { tenantId, status: 'granted' } }),
        tx.consentRecord.count({ where: { tenantId, status: 'withdrawn' } }),
        tx.consentRecord.count({ where: { tenantId, status: 'expired' } }),
        tx.consentRecord.count({ where: { tenantId, status: 'superseded' } }),
      ]);
      const consentCounts: ConsentStatusCounts = {
        granted: consentCountsRaw[0],
        withdrawn: consentCountsRaw[1],
        expired: consentCountsRaw[2],
        superseded: consentCountsRaw[3],
      };
      const recentConsentRows = await tx.consentRecord.findMany({
        where: { tenantId },
        // Order by updatedAt so a fresh withdrawal floats to the top
        // alongside fresh grants — operators want recency, not
        // grant-time chronology.
        orderBy: { updatedAt: 'desc' },
        take: CONSENT_RECENT_LIMIT,
      });
      const recentConsentChanges = recentConsentRows.map((c) => ({
        id: c.id,
        patientId: c.patientId,
        consentType: c.consentType as
          | 'nhcx_processing'
          | 'pmjay_processing'
          | 'analytics'
          | 'communication',
        status: c.status as 'granted' | 'withdrawn' | 'expired' | 'superseded',
        grantedAt: c.grantedAt.toISOString(),
        withdrawnAt: c.withdrawnAt?.toISOString() ?? null,
      }));

      return {
        generatedAt: now.toISOString(),
        retentionClasses,
        recentErasures,
        erasureCounts: { completed: erasureCompleted, rejected: erasureRejected },
        recentDataAccess,
        unboundAccessCountLast24h,
        breachCounts: {
          detected: breachDetected,
          notified: breachNotified,
          dismissed: breachDismissed,
          resolved: breachResolved,
        },
        openBreaches,
        consentCounts,
        recentConsentChanges,
      };
    });
  }
}

function countBlockingClaims(reason: unknown): number {
  if (!reason || typeof reason !== 'object') return 0;
  const obj = reason as { blockingClaims?: unknown };
  return Array.isArray(obj.blockingClaims) ? obj.blockingClaims.length : 0;
}
