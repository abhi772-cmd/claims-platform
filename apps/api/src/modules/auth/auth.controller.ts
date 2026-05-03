import { type LoginRequest, LoginRequestSchema, type LoginResponse, type MeResponse } from '@claims/contracts';
import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
  UsePipes,
  HttpCode,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type CookieOptions, type Request, type Response } from 'express';

import { AuthService } from './auth.service.js';
import { ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME } from './cookie.constants.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RefreshTokenInvalidError } from '../../common/errors/auth-errors.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { type AppConfig } from '../../config/configuration.js';
import { UserService } from '../user/user.service.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UserService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  @Post('login')
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(LoginRequestSchema))
  async login(
    @Body() body: LoginRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    const userAgent = req.get('user-agent') ?? null;
    const ip = req.ip ?? null;
    const { accessToken, refreshToken, user } = await this.auth.login(body, userAgent, ip);

    this.setAuthCookies(res, accessToken, refreshToken);
    return { user };
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const cookies = req.cookies as Record<string, string> | undefined;
    const presented = cookies?.[REFRESH_COOKIE_NAME];
    if (!presented) throw new RefreshTokenInvalidError();
    const userAgent = req.get('user-agent') ?? null;
    const ip = req.ip ?? null;
    const { accessToken, refreshToken } = await this.auth.refresh(presented, userAgent, ip);
    this.setAuthCookies(res, accessToken, refreshToken);
    return { ok: true };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const cookies = req.cookies as Record<string, string> | undefined;
    await this.auth.logout(cookies?.[REFRESH_COOKIE_NAME] ?? null);
    this.clearAuthCookies(res);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: Express.AuthenticatedUser): Promise<MeResponse> {
    const me = await this.users.getMe(user.tenantId, user.userId);
    if (!me) throw new RefreshTokenInvalidError();
    return me;
  }

  private setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
    const base = this.cookieOptions();
    res.cookie(ACCESS_COOKIE_NAME, accessToken, {
      ...base,
      maxAge: parseDurationMs(this.config.get('JWT_ACCESS_TTL', { infer: true })),
    });
    res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
      ...base,
      path: '/auth',
      maxAge: parseDurationMs(this.config.get('JWT_REFRESH_TTL', { infer: true })),
    });
  }

  private clearAuthCookies(res: Response): void {
    const base = this.cookieOptions();
    res.clearCookie(ACCESS_COOKIE_NAME, base);
    res.clearCookie(REFRESH_COOKIE_NAME, { ...base, path: '/auth' });
  }

  private cookieOptions(): CookieOptions {
    const sameSite = this.config.get('COOKIE_SAMESITE', { infer: true });
    return {
      httpOnly: true,
      secure: this.config.get('COOKIE_SECURE', { infer: true }),
      sameSite,
      domain: this.config.get('COOKIE_DOMAIN', { infer: true }),
      path: '/',
    };
  }
}

function parseDurationMs(input: string): number {
  const m = /^(\d+)\s*(ms|s|m|h|d)$/.exec(input.trim());
  if (!m) throw new Error(`Invalid duration: ${input}`);
  const n = Number(m[1]);
  const unit = m[2];
  switch (unit) {
    case 'ms':
      return n;
    case 's':
      return n * 1000;
    case 'm':
      return n * 60 * 1000;
    case 'h':
      return n * 60 * 60 * 1000;
    case 'd':
      return n * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`Invalid duration unit: ${String(unit)}`);
  }
}
