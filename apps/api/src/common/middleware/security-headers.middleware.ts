import { Injectable, type NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type NextFunction, type Request, type Response } from 'express';

import { type AppConfig } from '../../config/configuration';

// Security response headers. Applied to every response from the API.
// We deliberately don't use `helmet` — its defaults conflict with our
// CSP shape (we want a tight default-src 'none' with explicit allow
// list, helmet ships a permissive default-src 'self'), and we need
// CORS-aware handling of cross-origin headers that helmet doesn't do
// out of the box. Hand-rolling the half-dozen headers we actually want
// is simpler than configuring helmet to undo most of its defaults.
@Injectable()
export class SecurityHeadersMiddleware implements NestMiddleware {
  private readonly cspValue: string;
  private readonly hstsEnabled: boolean;
  private readonly hstsValue: string;
  private readonly permissionsPolicy: string;
  private readonly referrerPolicy: string;

  constructor(config: ConfigService<AppConfig, true>) {
    const isProd = config.get('NODE_ENV', { infer: true }) === 'production';
    const corsOrigin = config.get('CORS_ORIGIN', { infer: true });

    // CSP for the API. The API serves only JSON — no HTML — so the
    // policy is intentionally restrictive: no scripts, no styles, no
    // frames anywhere. The web app (Next.js) ships its own CSP from
    // its own headers config; this is the API surface only.
    this.cspValue = [
      "default-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      // connect-src lets browser-side debug tooling (curl-ish previews)
      // talk to the API. The web app talks via fetch + cookies, not
      // browser-loaded HTML, so this is mostly cosmetic.
      `connect-src ${corsOrigin}`,
    ].join('; ');

    // HSTS only when COOKIE_SECURE is on (i.e. production-ish setup).
    // Sending HSTS over plain HTTP can lock dev environments out of
    // localhost over HTTPS upgrades, so we gate it.
    this.hstsEnabled = config.get('COOKIE_SECURE', { infer: true });
    this.hstsValue = isProd
      ? 'max-age=63072000; includeSubDomains; preload'
      : 'max-age=300';

    // Disable powerful browser features the API doesn't need.
    this.permissionsPolicy = [
      'accelerometer=()',
      'autoplay=()',
      'camera=()',
      'geolocation=()',
      'gyroscope=()',
      'magnetometer=()',
      'microphone=()',
      'payment=()',
      'usb=()',
    ].join(', ');

    // Don't leak path info on cross-origin requests.
    this.referrerPolicy = 'no-referrer';
  }

  use(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader('Content-Security-Policy', this.cspValue);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', this.referrerPolicy);
    res.setHeader('Permissions-Policy', this.permissionsPolicy);
    // Cross-Origin-Opener-Policy + COEP — defence in depth against
    // window.opener tampering and cross-origin isolation breaks.
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    if (this.hstsEnabled) {
      res.setHeader('Strict-Transport-Security', this.hstsValue);
    }
    // Strip Express's default X-Powered-By — already disabled at the
    // app level via app.disable('x-powered-by') but we belt-and-brace.
    res.removeHeader('X-Powered-By');
    next();
  }
}
