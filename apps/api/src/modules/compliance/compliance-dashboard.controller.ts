// Slice BU — DPDP / IRDAI / RBI compliance dashboard endpoint.
//
// Single tenant-scoped read. audit.view gates access — the same
// permission that powers the audit log viewer, since the dashboard
// is the operator's "everything compliance" surface.

import { type ComplianceDashboard, Permissions } from '@claims/contracts';
import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ComplianceDashboardService } from './compliance-dashboard.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('compliance')
@Controller('admin/compliance')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ComplianceDashboardController {
  constructor(private readonly service: ComplianceDashboardService) {}

  @Get('dashboard')
  @RequirePermission(Permissions.AUDIT_VIEW)
  async dashboard(
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<ComplianceDashboard> {
    return this.service.load(user.tenantId);
  }
}
