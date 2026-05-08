// Slice BS — DPDP §8(6) breach anomaly detector.
//
// v1 heuristic: BURST_DECRYPT.
//   For each (tenantId, actorUserId) seen in the data_access_event
//   ledger over the last `windowMinutes`, count distinct patient
//   resourceIds that were decrypted (action='decrypt',
//   resourceType='patient'). If the count exceeds
//   BURST_DECRYPT_PATIENT_THRESHOLD, open a BURST_DECRYPT incident
//   tagged with the dataCategory union from the events' fieldNames
//   columns and the event ids as evidence.
//
// Why "distinct patients" not "raw event count": one operator
// triaging a single complex case may legitimately decrypt the same
// patient's fields a dozen times. The signal is breadth, not depth —
// touching many patients quickly is the suspicious pattern.
//
// Why no cross-tenant probe heuristic in v1: we don't currently log
// RLS denials (denied reads return null without writing a row). When
// BU's dashboard ships and the access ledger expands to log denied
// reads, a CROSS_TENANT_PROBE detector becomes meaningful. For now,
// a single signal that's actually grounded in available data beats
// a stub.
//
// Idempotency: windowStart is rounded down to the minute boundary,
// so re-running scan() multiple times within the same minute
// converges on the same row through the unique constraint
// (tenantId, kind, actorUserId, windowStart). Operators can run
// the CLI as often as they like without duplicating incidents.

import { type BreachKind, type BreachScanResult } from '@claims/contracts';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';


import { BreachIncidentService } from './breach-incident.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditEvents } from '../audit/audit.events';

// Tunables. Defaults are deliberately conservative — chosen to
// trigger on operator workflows that are rare-but-not-impossible
// (a 50-patient single-window decrypt by one operator is a
// reasonable threshold for "review me"; lower values would create
// alert fatigue, higher values would let real burst-exfiltration
// slip past).
const BURST_DECRYPT_PATIENT_THRESHOLD = 50;
const DEFAULT_WINDOW_MINUTES = 60;
// Cap evidence event ids per incident so the JSON column doesn't
// grow unbounded — beyond ~100 the dashboard can't render it
// usefully and the operator should query the ledger directly.
const MAX_EVIDENCE_EVENT_IDS = 100;

interface ActorBucket {
  tenantId: string;
  actorUserId: string;
  patientIds: Set<string>;
  fieldNamesUnion: Set<string>;
  evidenceEventIds: string[];
}

@Injectable()
export class BreachDetectorService {
  private readonly log = new Logger(BreachDetectorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly incidents: BreachIncidentService,
  ) {}

  // Run one detection pass over the most recent `windowMinutes` of
  // data_access_event rows. Returns per-kind counts of incidents
  // created (re-runs in the same minute return zeros after the
  // first one — that's the idempotency story).
  //
  // Platform-wide pass: this scans across every tenant in a single
  // query. The detector itself runs as platform_admin so it can
  // SELECT data_access_event rows tenant-blind; incident inserts
  // happen inside per-tenant runInTenantContext blocks so the RLS
  // INSERT policy permits them.
  async scan(opts: { windowMinutes?: number; now?: Date } = {}): Promise<BreachScanResult> {
    const start = Date.now();
    const now = opts.now ?? new Date();
    const windowMinutes = opts.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
    const windowEnd = roundDownToMinute(now);
    const windowStart = new Date(windowEnd.getTime() - windowMinutes * 60 * 1000);

    // Pull recent decrypt events. Use platform_admin so we can scan
    // every tenant in a single pass — RLS still gates the per-tenant
    // INSERT below.
    const events = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      return tx.dataAccessEvent.findMany({
        where: {
          action: 'decrypt',
          resourceType: 'patient',
          actorUserId: { not: null },
          resourceId: { not: null },
          occurredAt: { gte: windowStart, lt: windowEnd },
        },
        select: {
          id: true,
          tenantId: true,
          actorUserId: true,
          resourceId: true,
          fieldNames: true,
        },
      });
    });

    // Bucket by (tenantId, actorUserId).
    const buckets = new Map<string, ActorBucket>();
    for (const e of events) {
      if (!e.actorUserId || !e.resourceId) continue;
      const key = `${e.tenantId}::${e.actorUserId}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          tenantId: e.tenantId,
          actorUserId: e.actorUserId,
          patientIds: new Set<string>(),
          fieldNamesUnion: new Set<string>(),
          evidenceEventIds: [],
        };
        buckets.set(key, bucket);
      }
      bucket.patientIds.add(e.resourceId);
      if (Array.isArray(e.fieldNames)) {
        for (const f of e.fieldNames) {
          if (typeof f === 'string') bucket.fieldNamesUnion.add(f);
        }
      }
      if (bucket.evidenceEventIds.length < MAX_EVIDENCE_EVENT_IDS) {
        bucket.evidenceEventIds.push(e.id);
      }
    }

    // Open incidents for buckets over threshold. Each insert runs
    // in its own per-tenant transaction so the RLS INSERT policy
    // matches. Idempotency is enforced by the unique constraint:
    // openAutoWithTx returns null if an existing row covers the
    // same (tenant, kind, actor, windowStart) tuple.
    const byKind: Partial<Record<BreachKind, number>> = {};
    let incidentsCreated = 0;
    for (const bucket of buckets.values()) {
      if (bucket.patientIds.size < BURST_DECRYPT_PATIENT_THRESHOLD) continue;

      const dataCategories = bucket.fieldNamesUnion.size > 0
        ? Array.from(bucket.fieldNamesUnion)
        : ['patient'];
      const description =
        `BURST_DECRYPT detected: actor decrypted ${bucket.patientIds.size} distinct patients ` +
        `between ${windowStart.toISOString()} and ${windowEnd.toISOString()}. ` +
        `Field categories accessed: ${dataCategories.join(', ')}. ` +
        `Threshold: ${BURST_DECRYPT_PATIENT_THRESHOLD} distinct patients per ${windowMinutes}m window.`;

      const opened = await this.prisma.runInTenantContext(
        bucket.tenantId,
        'tenant',
        (tx) =>
          this.incidents.openAutoWithTx(tx, {
            tenantId: bucket.tenantId,
            kind: 'BURST_DECRYPT',
            severity: 'high',
            actorUserId: bucket.actorUserId,
            affectedDataPrincipals: bucket.patientIds.size,
            dataCategories,
            description,
            evidenceEventIds: bucket.evidenceEventIds,
            windowStart,
            windowEnd,
          }),
      );
      if (opened) {
        incidentsCreated += 1;
        byKind.BURST_DECRYPT = (byKind.BURST_DECRYPT ?? 0) + 1;
      }
    }

    const durationMs = Date.now() - start;
    const completedAt = new Date().toISOString();
    this.log.log(
      `breach detector scan complete incidentsCreated=${incidentsCreated} ` +
        `windowMinutes=${windowMinutes} durationMs=${durationMs} bucketsExamined=${buckets.size}`,
    );

    // Self-audit row — governance class via the static map.
    // tenantId is the platform sentinel so the row is platform-scoped.
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "audit_log"
          ("id", "tenantId", "actorType", "action", "resourceType", "after", "retentionClass")
        VALUES (
          gen_random_uuid(),
          '00000000-0000-0000-0000-000000000000'::uuid,
          'scheduled',
          ${AuditEvents.BREACH_DETECTOR_SCAN_COMPLETED},
          'breach_incident',
          ${JSON.stringify({
            incidentsCreated,
            byKind,
            durationMs,
            completedAt,
            bucketsExamined: buckets.size,
            windowMinutes,
          })}::jsonb,
          'governance'
        )
      `);
    });

    return {
      incidentsCreated,
      byKind,
      durationMs,
      completedAt,
    };
  }
}

function roundDownToMinute(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 60000) * 60000);
}
