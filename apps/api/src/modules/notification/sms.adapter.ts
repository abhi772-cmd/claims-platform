import { Injectable, Logger } from '@nestjs/common';

import { type RenderedSms } from './notification.types';
import { TenantCommsConfigService } from './tenant-comms-config.service';
import { TextGuruSmsProvider } from './textguru-sms.provider';

// V1 SMS adapter — selects the provider per-tenant via
// `TenantCommsConfigService`.
//   console  — log-only stub (default for dev + tenants without an SMS contract)
//   textguru — TextGuruSmsProvider (Slice AR): real HTTP POST to the
//              gateway with the per-tenant apiKey. Throws on non-2xx /
//              network error so the upstream notification_outbox row
//              flips to 'failed' (the surrounding API call still
//              succeeds; notification failure is non-fatal).
//
// New providers go through this adapter — call sites stay unchanged.
@Injectable()
export class SmsAdapter {
  private readonly log = new Logger(SmsAdapter.name);

  constructor(
    private readonly comms: TenantCommsConfigService,
    private readonly textguru: TextGuruSmsProvider,
  ) {}

  async send(tenantId: string, to: string, rendered: RenderedSms): Promise<void> {
    const sms = await this.comms.resolveSms(tenantId);
    const text = rendered.text.replace(/\n/g, ' / ');
    if (sms.provider === 'textguru') {
      if (!sms.apiKey) {
        throw new Error(
          `tenantId=${tenantId} provider=textguru has no apiKey on commsConfig`,
        );
      }
      await this.textguru.send({
        apiKey: sms.apiKey,
        senderId: sms.senderId,
        to,
        text,
      });
      return;
    }
    // console (default)
    this.log.log(`[SMS-STUB] tenantId=${tenantId} to=${to} text="${text}"`);
  }
}
