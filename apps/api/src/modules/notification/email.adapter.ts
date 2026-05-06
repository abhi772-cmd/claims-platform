import { Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';

import { type RenderedEmail } from './notification.types';
import { type ResolvedSmtp, TenantCommsConfigService } from './tenant-comms-config.service';

interface CachedTransporter {
  key: string;
  transporter: Transporter;
  fromAddress: string;
}

// SMTP-based email adapter. Looks up the SMTP relay per-tenant via
// `TenantCommsConfigService` — when the tenant has no override the
// resolver returns the platform env defaults (Mailhog in dev). The
// per-tenant Transporter is cached, keyed by the resolved config
// fingerprint, so we don't rebuild a connection pool every send.
@Injectable()
export class EmailAdapter {
  private readonly log = new Logger(EmailAdapter.name);
  private readonly transporters = new Map<string, CachedTransporter>();

  constructor(private readonly comms: TenantCommsConfigService) {}

  async send(tenantId: string, to: string, rendered: RenderedEmail): Promise<void> {
    const smtp = await this.comms.resolveSmtp(tenantId);
    const cached = this.getOrCreate(tenantId, smtp);
    await cached.transporter.sendMail({
      from: cached.fromAddress,
      to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
    this.log.debug(
      `email sent tenantId=${tenantId} to=${to} subject="${rendered.subject}" source=${smtp.source}`,
    );
  }

  private getOrCreate(tenantId: string, smtp: ResolvedSmtp): CachedTransporter {
    const key = transporterKey(smtp);
    const existing = this.transporters.get(tenantId);
    if (existing && existing.key === key) return existing;
    if (existing) {
      // Tenant rotated their SMTP — close the old pool before swapping.
      existing.transporter.close();
    }
    const transporter = createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      ignoreTLS: smtp.ignoreTls,
      ...(smtp.username && smtp.password
        ? { auth: { user: smtp.username, pass: smtp.password } }
        : {}),
    });
    const entry: CachedTransporter = { key, transporter, fromAddress: smtp.from };
    this.transporters.set(tenantId, entry);
    return entry;
  }
}

// Fingerprint a resolved SMTP config so transporter cache invalidation
// happens automatically when the tenant edits any field.
function transporterKey(smtp: ResolvedSmtp): string {
  return [
    smtp.host,
    smtp.port,
    smtp.from,
    smtp.username ?? '',
    smtp.password ? 'pw' : '',
    smtp.secure ? '1' : '0',
    smtp.ignoreTls ? '1' : '0',
  ].join('|');
}
