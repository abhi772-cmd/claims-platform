import { Injectable, Logger } from '@nestjs/common';

import { type RenderedSms } from './notification.types';
import { TenantCommsConfigService } from './tenant-comms-config.service';

// V1 SMS adapter — selects the provider per-tenant via
// `TenantCommsConfigService`.
//   console — log-only stub (default for dev + tenants without an SMS contract)
//   textguru — placeholder for the production SMS gateway. The real
//              HTTP integration lands in a dedicated provider class
//              once we have credentials; for now it logs the same way
//              as console but with a different prefix so ops can grep
//              the dispatch path.
//
// New providers go through this adapter — call sites stay unchanged.
@Injectable()
export class SmsAdapter {
  private readonly log = new Logger(SmsAdapter.name);

  constructor(private readonly comms: TenantCommsConfigService) {}

  async send(tenantId: string, to: string, rendered: RenderedSms): Promise<void> {
    const sms = await this.comms.resolveSms(tenantId);
    const text = rendered.text.replace(/\n/g, ' / ');
    if (sms.provider === 'textguru') {
      // TODO Sprint 5: replace with real TextGuru HTTP POST. For now
      // we keep the dispatch deterministic (logs and returns) so the
      // outbox row flips to 'sent' and the rest of the pipeline can
      // be exercised end-to-end with provider=textguru selected.
      this.log.log(
        `[SMS-TEXTGURU-STUB] tenantId=${tenantId} to=${to} senderId=${sms.senderId ?? '-'} text="${text}"`,
      );
      if (!sms.apiKey) {
        // Surface misconfiguration loudly without breaking the send.
        this.log.warn(
          `tenantId=${tenantId} provider=textguru has no apiKey — production sends would fail`,
        );
      }
      return;
    }
    // console (default)
    this.log.log(`[SMS-STUB] tenantId=${tenantId} to=${to} text="${text}"`);
  }
}
