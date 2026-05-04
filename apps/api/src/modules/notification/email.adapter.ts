import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';

import { type RenderedEmail } from './notification.types';
import { type AppConfig } from '../../config/configuration';

// SMTP-based email adapter. In dev points at Mailhog (1025); in prod points
// at the tenant's configured SMTP relay. Per-tenant SMTP config lives in
// Tenant.config and is loaded by the higher-level NotificationService.
@Injectable()
export class EmailAdapter {
  private readonly log = new Logger(EmailAdapter.name);
  private readonly transporter: Transporter;
  private readonly fromAddress: string;

  constructor(config: ConfigService<AppConfig, true>) {
    const host = config.get('SMTP_HOST', { infer: true });
    const port = config.get('SMTP_PORT', { infer: true });
    const fromAddress = config.get('SMTP_FROM', { infer: true });
    this.fromAddress = fromAddress;
    this.transporter = createTransport({
      host,
      port,
      secure: false,
      // Mailhog accepts unauthenticated. Real relays will get tenant creds
      // injected once we move SMTP config to tenant.config.
      ignoreTLS: true,
    });
  }

  async send(to: string, rendered: RenderedEmail): Promise<void> {
    await this.transporter.sendMail({
      from: this.fromAddress,
      to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
    this.log.debug(`email sent to=${to} subject="${rendered.subject}"`);
  }
}
