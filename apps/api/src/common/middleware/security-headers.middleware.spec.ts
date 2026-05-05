import { type ConfigService } from '@nestjs/config';
import { type Request, type Response } from 'express';

import { SecurityHeadersMiddleware } from './security-headers.middleware';

const cfg = (values: Record<string, unknown>): ConfigService =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

interface FakeRes {
  headers: Record<string, string>;
  setHeader: (k: string, v: string) => void;
  removeHeader: (k: string) => void;
}

const makeRes = (): FakeRes => {
  const h: Record<string, string> = { 'X-Powered-By': 'Express' };
  return {
    headers: h,
    setHeader: (k: string, v: string) => {
      h[k] = v;
    },
    removeHeader: (k: string) => {
      delete h[k];
    },
  };
};

describe('SecurityHeadersMiddleware', () => {
  it('sets CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy', () => {
    const mw = new SecurityHeadersMiddleware(
      cfg({
        NODE_ENV: 'production',
        CORS_ORIGIN: 'https://app.example.com',
        COOKIE_SECURE: true,
      }) as never,
    );
    const res = makeRes();
    let nextCalled = false;
    mw.use({} as Request, res as unknown as Response, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(res.headers['Content-Security-Policy']).toContain("default-src 'none'");
    expect(res.headers['Content-Security-Policy']).toContain('https://app.example.com');
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res.headers['X-Frame-Options']).toBe('DENY');
    expect(res.headers['Referrer-Policy']).toBe('no-referrer');
    expect(res.headers['Permissions-Policy']).toContain('camera=()');
    expect(res.headers['Cross-Origin-Opener-Policy']).toBe('same-origin');
  });

  it('strips X-Powered-By', () => {
    const mw = new SecurityHeadersMiddleware(
      cfg({
        NODE_ENV: 'development',
        CORS_ORIGIN: 'http://localhost:3000',
        COOKIE_SECURE: false,
      }) as never,
    );
    const res = makeRes();
    expect(res.headers['X-Powered-By']).toBe('Express');
    mw.use({} as Request, res as unknown as Response, () => undefined);
    expect(res.headers['X-Powered-By']).toBeUndefined();
  });

  it('emits HSTS only when COOKIE_SECURE=true', () => {
    const insecure = new SecurityHeadersMiddleware(
      cfg({
        NODE_ENV: 'development',
        CORS_ORIGIN: 'http://localhost:3000',
        COOKIE_SECURE: false,
      }) as never,
    );
    const r1 = makeRes();
    insecure.use({} as Request, r1 as unknown as Response, () => undefined);
    expect(r1.headers['Strict-Transport-Security']).toBeUndefined();

    const secure = new SecurityHeadersMiddleware(
      cfg({
        NODE_ENV: 'production',
        CORS_ORIGIN: 'https://app.example.com',
        COOKIE_SECURE: true,
      }) as never,
    );
    const r2 = makeRes();
    secure.use({} as Request, r2 as unknown as Response, () => undefined);
    expect(r2.headers['Strict-Transport-Security']).toContain('max-age=63072000');
    expect(r2.headers['Strict-Transport-Security']).toContain('includeSubDomains');
  });

  it('uses a short HSTS max-age in non-production even when secure', () => {
    const mw = new SecurityHeadersMiddleware(
      cfg({
        NODE_ENV: 'development',
        CORS_ORIGIN: 'https://staging.example.com',
        COOKIE_SECURE: true,
      }) as never,
    );
    const res = makeRes();
    mw.use({} as Request, res as unknown as Response, () => undefined);
    expect(res.headers['Strict-Transport-Security']).toBe('max-age=300');
  });
});
