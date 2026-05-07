// Slice AT — global rate-limit guard for `/nhcx/inbound`.
//
// Protects the public webhook against a misconfigured / runaway NHCX
// gateway flooding us with callbacks. Sits *after* the signature
// guard (AO) in the @UseGuards order: floods from anyone but the
// real gateway are already 401'd, so this bucket only counts
// authenticated traffic. Counts the whole endpoint, not per-IP — the
// gateway's a single sender from our perspective, so per-IP would
// effectively be the same shape.
//
// Implementation is a fixed-window counter: at the first request
// after a minute has passed since `windowStart`, we reset the count
// to 0 and roll the window forward. Cheap, single-replica scoped (a
// distributed limit needs Redis; deferred to the BullMQ slice that
// will already touch Redis surface).
//
// `NHCX_INBOUND_RATE_LIMIT_PER_MINUTE=0` disables the guard entirely
// — the test default in the existing inbound suites, since several
// already-merged tests fire dozens of callbacks back-to-back and we
// don't want to retrofit them with sleeps.

import {
  CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { type AppConfig } from '../../../config/configuration';

const WINDOW_MS = 60_000;

@Injectable()
export class NhcxInboundRateLimitGuard implements CanActivate {
  private readonly log = new Logger(NhcxInboundRateLimitGuard.name);
  private windowStart = 0;
  private count = 0;

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  canActivate(_context: ExecutionContext): boolean {
    const limit = this.config.get('NHCX_INBOUND_RATE_LIMIT_PER_MINUTE', { infer: true });
    if (!limit || limit <= 0) return true;

    const now = Date.now();
    if (now - this.windowStart >= WINDOW_MS) {
      this.windowStart = now;
      this.count = 0;
    }
    this.count += 1;
    if (this.count > limit) {
      // Log once at the boundary so ops sees the throttle starting.
      // Subsequent rejects in the same window stay quiet — pino would
      // otherwise drown the trace in identical lines.
      if (this.count === limit + 1) {
        this.log.warn(
          `nhcx inbound rate limit exceeded count=${this.count} limit=${limit}/min`,
        );
      }
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Inbound rate limit exceeded',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
