import {
  AcceptInviteRequestSchema,
  type AcceptInviteRequest,
  type ChangePasswordRequest,
  ChangePasswordRequestSchema,
  type InvitePreview,
  type LoginRequest,
  LoginRequestSchema,
  type LoginResponse,
  type MeResponse,
  type PasswordPolicyDescriptor,
  type PasswordResetCompleteRequest,
  PasswordResetCompleteRequestSchema,
  type PasswordResetInitiateRequest,
  PasswordResetInitiateRequestSchema,
  type PasswordResetVerifyResponse,
} from '@claims/contracts';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type CookieOptions, type Request, type Response } from 'express';

import { AuthService } from './auth.service';
import { ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME } from './cookie.constants';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RefreshTokenInvalidError } from '../../common/errors/auth-errors';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { type AppConfig } from '../../config/configuration';
import { PasswordPolicyService, PasswordService } from '../password';
import { InviteService } from '../user/invite.service';
import { UserService } from '../user/user.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UserService,
    private readonly invites: InviteService,
    private readonly passwords: PasswordService,
    private readonly policy: PasswordPolicyService,
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

  // Lightweight permission probe for the frontend. Uses the JWT-embedded
  // permission set (no DB hit). The frontend hides UI based on this.
  @Get('me/permissions')
  @UseGuards(JwtAuthGuard)
  mePermissions(@CurrentUser() user: Express.AuthenticatedUser): {
    permissions: readonly string[];
    roles: readonly string[];
  } {
    return { permissions: user.permissions, roles: user.roles };
  }

  // Public invite preview — used by the accept-invite page to show the
  // user who they are about to be onboarded as before they enter a password.
  @Get('invite/:token')
  async invitePreview(@Param('token') rawToken: string): Promise<InvitePreview> {
    const preview = await this.invites.preview(rawToken);
    return {
      email: preview.email,
      firstName: preview.firstName,
      lastName: preview.lastName,
      tenantDisplayName: preview.tenantDisplayName,
      roles: preview.roles,
      expiresAt: preview.expiresAt.toISOString(),
    };
  }

  @Post('accept-invite')
  @HttpCode(204)
  @UsePipes(new ZodValidationPipe(AcceptInviteRequestSchema))
  async acceptInvite(
    @Body() body: AcceptInviteRequest,
    @Req() req: Request,
  ): Promise<void> {
    await this.invites.accept(
      { rawToken: body.token, password: body.password },
      req.ip ?? null,
      req.get('user-agent') ?? null,
    );
  }

  // Public — describes the policy so the web app can render a strength
  // meter without hard-coding the rules in two places.
  @Get('password-policy')
  passwordPolicy(): PasswordPolicyDescriptor {
    return this.policy.describe();
  }

  // Public — always returns 204 to avoid leaking account existence.
  @Post('password-reset/initiate')
  @HttpCode(204)
  async initiateReset(
    @Body(new ZodValidationPipe(PasswordResetInitiateRequestSchema))
    body: PasswordResetInitiateRequest,
    @Req() req: Request,
  ): Promise<void> {
    await this.passwords.initiate({
      email: body.email,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
  }

  // Public — pre-flight before showing the new-password form.
  @Get('password-reset/verify')
  async verifyReset(@Query('token') rawToken: string): Promise<PasswordResetVerifyResponse> {
    const out = await this.passwords.verify(rawToken);
    return {
      ok: true,
      email: out.email,
      firstName: out.firstName,
      expiresAt: out.expiresAt.toISOString(),
    };
  }

  @Post('password-reset/complete')
  @HttpCode(204)
  async completeReset(
    @Body(new ZodValidationPipe(PasswordResetCompleteRequestSchema))
    body: PasswordResetCompleteRequest,
    @Req() req: Request,
  ): Promise<void> {
    await this.passwords.complete({
      rawToken: body.token,
      newPassword: body.password,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
  }

  @Post('me/password')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard)
  async changePassword(
    @Body(new ZodValidationPipe(ChangePasswordRequestSchema)) body: ChangePasswordRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
    @Req() req: Request,
  ): Promise<void> {
    await this.passwords.change({
      tenantId: user.tenantId,
      userId: user.userId,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
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
    // Coerce defensively — process.env round-trips strings even when our schema
    // declares boolean, and a truthy string ("false") would silently turn on Secure.
    const secureRaw: unknown = this.config.get('COOKIE_SECURE', { infer: true });
    const secure =
      typeof secureRaw === 'boolean'
        ? secureRaw
        : String(secureRaw).toLowerCase() === 'true';
    return {
      httpOnly: true,
      secure,
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
