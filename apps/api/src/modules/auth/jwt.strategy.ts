import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { type Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { ACCESS_COOKIE_NAME } from './cookie.constants';
import { type AppConfig } from '../../config/configuration';

export interface JwtPayload {
  sub: string;
  tid: string;
  rl: 'tenant' | 'platform_admin';
  rs: string[];
  sid: string;
}

function fromAccessCookie(req: Request): string | null {
  const cookies = req.cookies as Record<string, string> | undefined;
  if (!cookies) return null;
  return cookies[ACCESS_COOKIE_NAME] ?? null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService<AppConfig, true>) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([fromAccessCookie]),
      ignoreExpiration: false,
      secretOrKey: config.get('jwtPublicKeyPem', { infer: true }),
      algorithms: ['RS256'],
      issuer: config.get('JWT_ISSUER', { infer: true }),
      audience: config.get('JWT_AUDIENCE', { infer: true }),
      passReqToCallback: false,
    });
  }

  validate(payload: JwtPayload): Express.AuthenticatedUser {
    return {
      userId: payload.sub,
      tenantId: payload.tid,
      role: payload.rl,
      roles: payload.rs,
      sessionId: payload.sid,
    };
  }
}
