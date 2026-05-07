// Slice AO — Nest guard that wraps the pure http-signature verifier.
//
// Sits in front of the public `/nhcx/inbound` controller. When
// `NHCX_INBOUND_VERIFY_SIGNATURE=false` (dev / integration tests) the
// guard short-circuits to allow without signing. In production, the
// boot-time config check (configuration.ts) ensures the env is true,
// so reaching this guard with a missing / bad signature is a 401.
//
// The guard reads the request's raw body (provided by NestExpress'
// `rawBody: true` option in main.ts), looks at the headers, and asks
// the verifier whether the signature is valid against the gateway's
// public key. Failures are logged with the reason for ops triage and
// surface as UnauthorizedException.

import {
  CanActivate,
  type ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Request } from 'express';

import { verifyHttpSignature } from './http-signature';
import { type AppConfig } from '../../../config/configuration';

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

@Injectable()
export class NhcxInboundSignatureGuard implements CanActivate {
  private readonly log = new Logger(NhcxInboundSignatureGuard.name);

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const enabled = this.config.get('NHCX_INBOUND_VERIFY_SIGNATURE', { infer: true });
    if (!enabled) return true;

    const publicKeyPem = this.config.get('nhcxGatewayPublicKeyPem', { infer: true });
    if (!publicKeyPem) {
      // Belt-and-brace — the production config check should have
      // already failed boot. If we somehow get here without a key,
      // failing closed is the only safe answer.
      this.log.error('NHCX inbound signature verification enabled but gateway public key is missing');
      throw new UnauthorizedException('Inbound signature verification not configured');
    }

    const req = context.switchToHttp().getRequest<RawBodyRequest>();
    const rawBody = req.rawBody;
    if (!rawBody) {
      // bootstrap mis-config — main.ts didn't set rawBody:true, or the
      // request used a non-buffer body parser. Same fail-closed answer.
      this.log.error('NHCX inbound request has no raw body — bootstrap is missing rawBody:true');
      throw new UnauthorizedException('Inbound signature verification not configured');
    }

    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) headers[name.toLowerCase()] = value.join(', ');
      else if (typeof value === 'string') headers[name.toLowerCase()] = value;
    }

    const maxSkewSeconds = this.config.get('NHCX_INBOUND_SIGNATURE_MAX_SKEW_SECONDS', {
      infer: true,
    });

    const result = verifyHttpSignature({
      method: req.method,
      // The original URL (path + query) — Cavage signs the request-target
      // as the URI the server received. baseUrl is empty for our
      // top-level controller, so originalUrl is the right answer.
      path: req.originalUrl,
      headers,
      rawBody,
      publicKeyPem,
      now: new Date(),
      maxSkewSeconds,
    });

    if (!result.ok) {
      const correlationId = headers['x-hcx-correlation-id'] ?? '<missing>';
      this.log.warn(
        `nhcx inbound signature rejected correlationId=${correlationId} reason="${result.reason}"`,
      );
      throw new UnauthorizedException('Invalid HTTP signature');
    }
    return true;
  }
}
