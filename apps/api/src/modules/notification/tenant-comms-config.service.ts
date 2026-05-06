import {
  type TenantCommsConfig,
  type TenantCommsConfigSummary,
  TenantCommsConfigSchema,
} from '@claims/contracts';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../common/prisma/prisma.service';
import { type AppConfig } from '../../config/configuration';

// Resolved config the adapters consume. Always populated — falls back
// to env defaults when the tenant has no override.
export interface ResolvedSmtp {
  source: 'tenant' | 'env';
  host: string;
  port: number;
  from: string;
  username: string | null;
  password: string | null;
  secure: boolean;
  ignoreTls: boolean;
}

export interface ResolvedSms {
  source: 'tenant' | 'env';
  provider: 'console' | 'textguru';
  apiKey: string | null;
  senderId: string | null;
}

interface CacheEntry {
  config: TenantCommsConfig;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;

// Resolves the per-tenant comms (SMTP + SMS) config, with a thin
// in-memory cache so the adapters don't hit Postgres on every send.
// The cache TTL is 60s; writes via `update` invalidate the entry
// immediately so admin changes take effect on the next send.
//
// Reads use platform_admin RLS context — the resolver is called from
// background sends (NotificationService.dispatch / retry worker) where
// the tenant context isn't always live, and tenant.commsConfig is
// already RLS-gated for direct user reads via the admin endpoint.
@Injectable()
export class TenantCommsConfigService {
  private readonly log = new Logger(TenantCommsConfigService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async resolveSmtp(tenantId: string): Promise<ResolvedSmtp> {
    const cfg = await this.getConfig(tenantId);
    const smtp = cfg.smtp;
    if (smtp && smtp.host && smtp.port && smtp.from) {
      return {
        source: 'tenant',
        host: smtp.host,
        port: smtp.port,
        from: smtp.from,
        username: smtp.username ?? null,
        password: smtp.password ?? null,
        secure: smtp.secure ?? false,
        ignoreTls: smtp.ignoreTls ?? false,
      };
    }
    return {
      source: 'env',
      host: this.config.get('SMTP_HOST', { infer: true }),
      port: this.config.get('SMTP_PORT', { infer: true }),
      from: this.config.get('SMTP_FROM', { infer: true }),
      username: null,
      password: null,
      // Mailhog and the existing dev relay accept unauthenticated, plain.
      secure: false,
      ignoreTls: true,
    };
  }

  async resolveSms(tenantId: string): Promise<ResolvedSms> {
    const cfg = await this.getConfig(tenantId);
    const sms = cfg.sms;
    if (sms && sms.provider) {
      return {
        source: 'tenant',
        provider: sms.provider,
        apiKey: sms.apiKey ?? null,
        senderId: sms.senderId ?? null,
      };
    }
    return {
      source: 'env',
      provider: 'console',
      apiKey: null,
      senderId: null,
    };
  }

  // Admin read: returns a redacted summary suitable for the editor UI.
  // Secrets are never echoed back; the UI displays a "set / unset" badge
  // and lets the operator overwrite them.
  async getSummary(tenantId: string): Promise<TenantCommsConfigSummary> {
    const smtp = await this.resolveSmtp(tenantId);
    const sms = await this.resolveSms(tenantId);
    return {
      smtp: {
        host: smtp.host,
        port: smtp.port,
        from: smtp.from,
        username: smtp.username,
        passwordSet: smtp.password !== null,
        secure: smtp.source === 'tenant' ? smtp.secure : null,
        ignoreTls: smtp.source === 'tenant' ? smtp.ignoreTls : null,
        source: smtp.source,
      },
      sms: {
        provider: sms.provider,
        senderId: sms.senderId,
        apiKeySet: sms.apiKey !== null,
        source: sms.source,
      },
    };
  }

  // PATCH semantics: callers send the full new config object. Passing
  // `null` for a sub-key clears that override and falls back to env.
  // Omitted sub-keys keep the existing override in place. Secrets
  // (smtp.password, sms.apiKey) follow the same shape — if the caller
  // wants to clear just the password but keep the rest of the SMTP
  // override, they re-send the SMTP block without the password field.
  async update(
    tenantId: string,
    patch: TenantCommsConfig,
  ): Promise<TenantCommsConfigSummary> {
    const validated = TenantCommsConfigSchema.parse(patch);
    await this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const row = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { commsConfig: true },
      });
      const current = (row?.commsConfig as TenantCommsConfig | null) ?? {};
      const next: TenantCommsConfig = { ...current };
      if (validated.smtp === null) delete next.smtp;
      else if (validated.smtp !== undefined) next.smtp = validated.smtp;
      if (validated.sms === null) delete next.sms;
      else if (validated.sms !== undefined) next.sms = validated.sms;
      await tx.tenant.update({
        where: { id: tenantId },
        data: { commsConfig: next as never },
      });
    });
    this.invalidate(tenantId);
    return this.getSummary(tenantId);
  }

  // Test + admin-tooling hook to drop the cached entry for a tenant.
  // Called automatically by `update`.
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  private async getConfig(tenantId: string): Promise<TenantCommsConfig> {
    const cached = this.cache.get(tenantId);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.config;
    }
    const row = await this.prisma.runInTenantContext(
      tenantId,
      'platform_admin',
      (tx) =>
        tx.tenant.findUnique({
          where: { id: tenantId },
          select: { commsConfig: true },
        }),
    );
    const raw = (row?.commsConfig as unknown) ?? {};
    let config: TenantCommsConfig;
    try {
      config = TenantCommsConfigSchema.parse(raw);
    } catch (err) {
      // Don't crash the send path if a tenant has an invalid blob —
      // log and fall back to env defaults. The admin UI is responsible
      // for keeping the row valid.
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(
        `tenant ${tenantId} has invalid commsConfig, falling back to env (${message})`,
      );
      config = {};
    }
    this.cache.set(tenantId, { config, expiresAt: now + CACHE_TTL_MS });
    return config;
  }
}
