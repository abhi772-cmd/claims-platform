import { randomUUID } from 'node:crypto';

import { Prisma } from '@prisma/client';
import {
  type NhcxParticipantConfig,
  type NhcxParticipantListResponse,
  type NhcxParticipantRole,
  type NhcxParticipantStatusResponse,
  type RegisterNhcxParticipantRequest,
} from '@claims/contracts';
import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  NHCX_PARTICIPANT_CLIENT,
  type NhcxParticipantClient,
} from './nhcx-participant-client.interface';
import { TenantNotFoundError } from '../../common/errors/tenant-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { type TenantPrisma } from '../../types/express';
import { AuditEvents, AuditService } from '../audit';

// Slice ON-4 — orchestrates ops-on-behalf NHCX participant
// registration. Reads tenant identity, calls the client, persists the
// result in `tenant_nhcx_config`, writes a paired
// `integration_message` outbound + inbound record (per CLAUDE.md
// rule 7), and auto-completes the three NHCX onboarding steps that
// the registration satisfies.

export interface RegisterInput extends RegisterNhcxParticipantRequest {
  tenantId: string;
  actorUserId: string;
  ip: string | null;
  userAgent: string | null;
}

@Injectable()
export class NhcxParticipantService {
  private readonly log = new Logger(NhcxParticipantService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(NHCX_PARTICIPANT_CLIENT)
    private readonly client: NhcxParticipantClient,
  ) {}

  async list(): Promise<NhcxParticipantListResponse> {
    return runAsPlatformAdmin(this.prisma, async (tx) => {
      const tenants = await tx.tenant.findMany({
        orderBy: [{ displayName: 'asc' }],
        select: {
          id: true,
          slug: true,
          displayName: true,
          nhcxConfig: true,
        },
      });
      return {
        items: tenants.map((t) => ({
          tenantId: t.id,
          tenantSlug: t.slug,
          tenantDisplayName: t.displayName,
          config: t.nhcxConfig ? toConfigDto(t.nhcxConfig) : null,
        })),
      };
    });
  }

  async status(tenantId: string): Promise<NhcxParticipantStatusResponse> {
    return runAsPlatformAdmin(this.prisma, async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true, nhcxConfig: true },
      });
      if (!tenant) throw new TenantNotFoundError();
      return { config: tenant.nhcxConfig ? toConfigDto(tenant.nhcxConfig) : null };
    });
  }

  async register(input: RegisterInput): Promise<NhcxParticipantConfig> {
    const role: NhcxParticipantRole = input.role ?? 'provider';
    const sandboxMode = input.sandboxMode ?? true;

    // We don't have a tenant context to use the slug yet; fetch it
    // first so we can pass the slug to the client + audit downstream.
    const tenant = await runAsPlatformAdmin(this.prisma, (tx) =>
      tx.tenant.findUnique({
        where: { id: input.tenantId },
        select: { id: true, slug: true },
      }),
    );
    if (!tenant) throw new TenantNotFoundError();

    const correlationId = randomUUID();
    // Step 1: write the outbound integration_message row inside a
    // platform_admin tx so the call to NHA is auditable even if it
    // fails mid-flight. We mark it `pending`; the response handler
    // flips it to `succeeded` or `failed`.
    const outboundId = await runAsPlatformAdmin(this.prisma, async (tx) => {
      const row = await tx.integrationMessage.create({
        data: {
          tenantId: input.tenantId,
          direction: 'outbound',
          integration: 'nhcx',
          operation: 'participant/register',
          correlationId,
          status: 'pending',
          rawRequest: {
            hfrFacilityId: input.hfrFacilityId,
            callbackUrl: input.callbackUrl,
            role,
            sandboxMode,
          } as never,
          lastAttemptAt: new Date(),
        },
        select: { id: true },
      });
      return row.id;
    });

    // Step 2: actually call NHA (or stub). Outside any tx so a slow
    // network round-trip doesn't hold a Postgres connection open.
    try {
      const result = await this.client.registerParticipant({
        tenantId: input.tenantId,
        tenantSlug: tenant.slug,
        hfrFacilityId: input.hfrFacilityId,
        callbackUrl: input.callbackUrl,
        role,
        sandboxMode,
        initiatedByUserId: input.actorUserId,
      });

      // Step 3: persist the success — upsert tenant_nhcx_config, flip
      // the outbound row to succeeded, write the paired inbound row,
      // audit the action, and recompute derived onboarding steps. All
      // inside one tx so a failure rolls everything back.
      const persisted = await runAsPlatformAdmin(this.prisma, async (tx) => {
        const upserted = await tx.tenantNhcxConfig.upsert({
          where: { tenantId: input.tenantId },
          create: {
            tenantId: input.tenantId,
            hfrFacilityId: input.hfrFacilityId,
            participantCode: result.participantCode,
            role,
            callbackUrl: result.registeredCallbackUrl,
            sandboxMode,
            registeredAt: new Date(),
            registeredByUserId: input.actorUserId,
            lastError: null,
          },
          update: {
            hfrFacilityId: input.hfrFacilityId,
            participantCode: result.participantCode,
            role,
            callbackUrl: result.registeredCallbackUrl,
            sandboxMode,
            registeredAt: new Date(),
            registeredByUserId: input.actorUserId,
            lastError: null,
          },
        });
        await tx.integrationMessage.update({
          where: { id: outboundId },
          data: {
            status: 'succeeded',
            rawResponse: result.rawResponse as never,
            completedAt: new Date(),
          },
        });
        await tx.integrationMessage.create({
          data: {
            tenantId: input.tenantId,
            direction: 'inbound',
            integration: 'nhcx',
            operation: 'participant/register',
            correlationId,
            status: 'succeeded',
            rawResponse: result.rawResponse as never,
            completedAt: new Date(),
            lastAttemptAt: new Date(),
          },
        });
        await this.audit.recordWithTx(tx, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          actorType: 'user',
          action: AuditEvents.TENANT_UPDATED,
          resourceType: 'tenant_nhcx_config',
          resourceId: upserted.id,
          before: null,
          after: {
            participantCode: result.participantCode,
            role,
            callbackUrl: result.registeredCallbackUrl,
            sandboxMode,
          },
          ipAddress: input.ip,
          userAgent: input.userAgent,
          correlationId,
        });
        await recomputeNhcxOnboardingSteps(tx, input.tenantId, input.actorUserId);
        return upserted;
      });

      return toConfigDto(persisted);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(
        `participant/register failed for tenant=${input.tenantId}: ${message}`,
      );
      await runAsPlatformAdmin(this.prisma, async (tx) => {
        await tx.integrationMessage.update({
          where: { id: outboundId },
          data: {
            status: 'failed',
            failureClass: 'unknown',
            retryCount: { increment: 1 },
            completedAt: new Date(),
            rawResponse: { error: message } as never,
          },
        });
        // Surface the failure on the tenant_nhcx_config row so ops sees
        // it in the listing without diving into integration_message.
        // Only upsert if a row exists OR the failure should still be
        // visible — when nothing has been persisted yet, we create a
        // skeletal row with the inputs + lastError so the next attempt
        // can pick up the trail.
        await tx.tenantNhcxConfig.upsert({
          where: { tenantId: input.tenantId },
          create: {
            tenantId: input.tenantId,
            hfrFacilityId: input.hfrFacilityId,
            callbackUrl: input.callbackUrl,
            role,
            sandboxMode,
            participantCode: null,
            registeredAt: null,
            lastError: message.slice(0, 500),
          },
          update: {
            // Don't clobber an earlier success: only set lastError.
            hfrFacilityId: input.hfrFacilityId,
            callbackUrl: input.callbackUrl,
            role,
            sandboxMode,
            lastError: message.slice(0, 500),
          },
        });
      });
      throw err;
    }
  }
}

function toConfigDto(row: {
  hfrFacilityId: string;
  participantCode: string | null;
  role: string;
  callbackUrl: string;
  sandboxMode: boolean;
  registeredAt: Date | null;
  registeredByUserId: string | null;
  lastError: string | null;
}): NhcxParticipantConfig {
  return {
    hfrFacilityId: row.hfrFacilityId,
    participantCode: row.participantCode,
    role: row.role as NhcxParticipantRole,
    callbackUrl: row.callbackUrl,
    sandboxMode: row.sandboxMode,
    registeredAt: row.registeredAt ? row.registeredAt.toISOString() : null,
    registeredByUserId: row.registeredByUserId,
    lastError: row.lastError,
  };
}

// Recomputes the three onboarding steps that registration satisfies:
//   hfr_facility, nhcx_participant_code, nhcx_callback_url.
// Same idempotent pattern as KycService.recomputeDerivedSteps —
// skip the write when status would not change so the audit log
// stays clean.
async function recomputeNhcxOnboardingSteps(
  tx: TenantPrisma,
  tenantId: string,
  actorUserId: string,
): Promise<void> {
  const config = await tx.tenantNhcxConfig.findUnique({
    where: { tenantId },
    select: {
      hfrFacilityId: true,
      participantCode: true,
      callbackUrl: true,
    },
  });
  if (!config) return;
  await Promise.all([
    upsertStep(tx, tenantId, 'hfr_facility', Boolean(config.hfrFacilityId), actorUserId),
    upsertStep(
      tx,
      tenantId,
      'nhcx_participant_code',
      Boolean(config.participantCode),
      actorUserId,
    ),
    upsertStep(
      tx,
      tenantId,
      'nhcx_callback_url',
      Boolean(config.callbackUrl),
      actorUserId,
    ),
  ]);
}

async function upsertStep(
  tx: TenantPrisma,
  tenantId: string,
  stepKey: string,
  shouldBeComplete: boolean,
  actorUserId: string,
): Promise<void> {
  const targetStatus: 'completed' | 'pending' = shouldBeComplete ? 'completed' : 'pending';
  const existing = await tx.onboardingStep.findUnique({
    where: { tenantId_stepKey: { tenantId, stepKey } },
  });
  if (existing && existing.status === targetStatus) return;
  await tx.onboardingStep.upsert({
    where: { tenantId_stepKey: { tenantId, stepKey } },
    create: {
      tenantId,
      stepKey,
      status: targetStatus,
      evidence: { derived: true, source: 'nhcx_participant' } as never,
      completedAt: shouldBeComplete ? new Date() : null,
      completedBy: actorUserId,
    },
    update: {
      status: targetStatus,
      completedAt: shouldBeComplete ? new Date() : null,
      completedBy: actorUserId,
    },
  });
}

// Mirrors KycService's runAsPlatformAdmin — opens a $transaction with
// `app.role = 'platform_admin'` so RLS lets us see + write across
// every tenant. Same pattern as AuditRetentionSweeperService.
async function runAsPlatformAdmin<T>(
  prisma: PrismaService,
  cb: (tx: TenantPrisma) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      return cb(tx as unknown as TenantPrisma);
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}
