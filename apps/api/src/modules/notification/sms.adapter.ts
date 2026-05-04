import { Injectable, Logger } from '@nestjs/common';

import { type RenderedSms } from './notification.types';

// V1 SMS is a console-log stub per Sprint 1 decision. Real TextGuru
// integration lands in its own PR after the auth surface stabilises.
// The interface stays the same so the swap is just an adapter swap.
@Injectable()
export class SmsAdapter {
  private readonly log = new Logger(SmsAdapter.name);

  async send(to: string, rendered: RenderedSms): Promise<void> {
    // Single-line so log scrapers can grep this in dev.
    this.log.log(`[SMS-STUB] to=${to} text="${rendered.text.replace(/\n/g, ' / ')}"`);
  }
}
