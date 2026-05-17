import {
  type OperationalDashboardResponse,
  Permissions,
} from '@claims/contracts';
import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { DashboardService } from './dashboard.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('dashboard')
@Controller('dashboard')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  // Operational tile data for the dashboard landing page. Gated on
  // case.view — the broadest operator permission since every role
  // that opens cases needs to see "what's on my plate today."
  @Get('operational')
  @RequirePermission(Permissions.CASE_VIEW)
  async operational(
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<OperationalDashboardResponse> {
    return this.dashboard.operational(user.tenantId);
  }
}
