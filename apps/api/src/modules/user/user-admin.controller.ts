import {
  Permissions,
  type InviteUserRequest,
  InviteUserRequestSchema,
  type InviteUserResponse,
  type ListTenantUsersResponse,
} from '@claims/contracts';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Request } from 'express';

import { InviteService } from './invite.service';
import { UserService } from './user.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('tenant-users')
@Controller('tenant/users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UserAdminController {
  constructor(
    private readonly invites: InviteService,
    private readonly users: UserService,
  ) {}

  // Admin /tenant/users directory listing. Gated on user.invite —
  // anyone who can invite a teammate can see who already exists.
  @Get()
  @RequirePermission(Permissions.USER_INVITE)
  async list(
    @CurrentUser() actor: Express.AuthenticatedUser,
  ): Promise<ListTenantUsersResponse> {
    const users = await this.users.listForTenant(actor.tenantId);
    return { users };
  }

  @Post()
  @HttpCode(201)
  @RequirePermission(Permissions.USER_INVITE)
  async invite(
    // Bind the Zod pipe to @Body() only — @UsePipes at method-level would
    // also run on @CurrentUser() and validate the user object as
    // InviteUserRequest, which obviously fails.
    @Body(new ZodValidationPipe(InviteUserRequestSchema)) body: InviteUserRequest,
    @CurrentUser() actor: Express.AuthenticatedUser,
    @Req() req: Request,
  ): Promise<InviteUserResponse> {
    const created = await this.invites.invite(
      {
        tenantId: actor.tenantId,
        invitedById: actor.userId,
        email: body.email,
        firstName: body.firstName,
        lastName: body.lastName,
        ...(body.mobile !== undefined ? { mobile: body.mobile } : {}),
        ...(body.designation !== undefined ? { designation: body.designation } : {}),
        roles: body.roles,
      },
      req.ip ?? null,
      req.get('user-agent') ?? null,
    );
    return {
      user: {
        id: created.id,
        email: created.email,
        firstName: created.firstName,
        lastName: created.lastName,
        status: 'invited',
        inviteExpiresAt: created.inviteExpiresAt.toISOString(),
      },
    };
  }

  @Post(':id/resend-invite')
  @HttpCode(200)
  @RequirePermission(Permissions.USER_INVITE)
  async resend(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() actor: Express.AuthenticatedUser,
    @Req() req: Request,
  ): Promise<{ inviteExpiresAt: string }> {
    const { inviteExpiresAt } = await this.invites.resend(
      actor.tenantId,
      id,
      actor.userId,
      req.ip ?? null,
      req.get('user-agent') ?? null,
    );
    return { inviteExpiresAt: inviteExpiresAt.toISOString() };
  }
}
