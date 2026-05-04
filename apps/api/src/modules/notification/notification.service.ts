import { Injectable, Logger } from '@nestjs/common';

import { EmailAdapter } from './email.adapter';
import { type NotificationChannel, type TemplateData, type TemplateKey } from './notification.types';
import { SmsAdapter } from './sms.adapter';
import { renderTemplate } from './templates';
import { PrismaService } from '../../common/prisma/prisma.service';
import { type TenantPrisma } from '../../types/express';

export interface DispatchInput<K extends TemplateKey> {
  tenantId: string;
  templateKey: K;
  data: TemplateData[K];
  email?: string;
  sms?: string;
}

// Renders + dispatches a notification.
// V1: dispatch synchronously in the request flow. The notification_outbox
// row is written first (so we have an audit trail), then we attempt
// delivery. Failures mark status='failed' with the error message; the
// route still succeeds because notification failure should not block
// (e.g.) an invite from being created.
//
// V2 will add a worker that retries failed rows + scheduled rows.
@Injectable()
export class NotificationService {
  private readonly log = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailAdapter,
    private readonly sms: SmsAdapter,
  ) {}

  async dispatch<K extends TemplateKey>(input: DispatchInput<K>): Promise<void> {
    const rendered = renderTemplate(input.templateKey, input.data);
    if (input.email && rendered.email) {
      await this.send(input.tenantId, 'email', input.templateKey, input.email, async () => {
        await this.email.send(input.email!, rendered.email!);
      }, input.data);
    }
    if (input.sms && rendered.sms) {
      await this.send(input.tenantId, 'sms', input.templateKey, input.sms, async () => {
        await this.sms.send(input.sms!, rendered.sms!);
      }, input.data);
    }
  }

  // Same as dispatch() but writes the outbox row inside an existing tenant
  // transaction so the notification atomically commits with the surrounding
  // state change (e.g. invite creation + outbox row in one tx). The actual
  // adapter send still happens AFTER the tx commits — adapter failures are
  // recorded as a status update on a follow-up tx and never roll back the
  // surrounding state.
  async enqueueWithTx<K extends TemplateKey>(
    tx: TenantPrisma,
    input: DispatchInput<K>,
  ): Promise<{ emailRowId?: string; smsRowId?: string }> {
    const rendered = renderTemplate(input.templateKey, input.data);
    const out: { emailRowId?: string; smsRowId?: string } = {};
    if (input.email && rendered.email) {
      const row = await tx.notificationOutbox.create({
        data: {
          tenantId: input.tenantId,
          channel: 'email',
          templateKey: input.templateKey,
          recipient: input.email,
          payload: input.data as never,
        },
      });
      out.emailRowId = row.id;
    }
    if (input.sms && rendered.sms) {
      const row = await tx.notificationOutbox.create({
        data: {
          tenantId: input.tenantId,
          channel: 'sms',
          templateKey: input.templateKey,
          recipient: input.sms,
          payload: input.data as never,
        },
      });
      out.smsRowId = row.id;
    }
    return out;
  }

  // Caller hands a list of outbox row ids enqueued in a prior tx; this
  // method dispatches and updates each row's status. Safe to call after
  // the parent tx commits.
  async dispatchEnqueued<K extends TemplateKey>(
    tenantId: string,
    rowIds: { emailRowId?: string; smsRowId?: string },
    templateKey: K,
    data: TemplateData[K],
    recipients: { email?: string; sms?: string },
  ): Promise<void> {
    const rendered = renderTemplate(templateKey, data);
    if (rowIds.emailRowId && rendered.email && recipients.email) {
      const emailRowId = rowIds.emailRowId;
      const recipient = recipients.email;
      await this.deliverAndMark(tenantId, emailRowId, () =>
        this.email.send(recipient, rendered.email!),
      );
    }
    if (rowIds.smsRowId && rendered.sms && recipients.sms) {
      const smsRowId = rowIds.smsRowId;
      const recipient = recipients.sms;
      await this.deliverAndMark(tenantId, smsRowId, () =>
        this.sms.send(recipient, rendered.sms!),
      );
    }
  }

  private async send(
    tenantId: string,
    channel: NotificationChannel,
    templateKey: TemplateKey,
    recipient: string,
    deliver: () => Promise<void>,
    payload: unknown,
  ): Promise<void> {
    const row = await this.prisma.runInTenantContext(tenantId, 'platform_admin', (tx) =>
      tx.notificationOutbox.create({
        data: { tenantId, channel, templateKey, recipient, payload: payload as never },
      }),
    );
    await this.deliverAndMark(tenantId, row.id, deliver);
  }

  private async deliverAndMark(
    tenantId: string,
    rowId: string,
    deliver: () => Promise<void>,
  ): Promise<void> {
    try {
      await deliver();
      await this.prisma.runInTenantContext(tenantId, 'platform_admin', (tx) =>
        tx.notificationOutbox.update({
          where: { id: rowId },
          data: { status: 'sent', sentAt: new Date(), attempts: { increment: 1 } },
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`notification dispatch failed rowId=${rowId} err=${message}`);
      await this.prisma.runInTenantContext(tenantId, 'platform_admin', (tx) =>
        tx.notificationOutbox.update({
          where: { id: rowId },
          data: { status: 'failed', lastError: message, attempts: { increment: 1 } },
        }),
      );
    }
  }
}
