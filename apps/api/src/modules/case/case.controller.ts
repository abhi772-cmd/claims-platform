import {
  type CaseDetail,
  type CreateCaseRequest,
  CreateCaseRequestSchema,
  type ListCasesResponse,
  Permissions,
  type UpdateCaseRequest,
  UpdateCaseRequestSchema,
} from '@claims/contracts';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { type Request } from 'express';

import { CaseService } from './case.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('cases')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CaseController {
  constructor(private readonly cases: CaseService) {}

  @Post()
  @HttpCode(201)
  @RequirePermission(Permissions.CASE_CREATE)
  async create(
    @Body(new ZodValidationPipe(CreateCaseRequestSchema)) body: CreateCaseRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
    @Req() req: Request,
  ): Promise<CaseDetail> {
    return this.cases.create({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      patientName: body.patientName,
      hospitalMrn: body.hospitalMrn,
      admissionDate: body.admissionDate,
      admissionType: body.admissionType,
      primaryRail: body.primaryRail,
      ...(body.treatingDoctorId !== undefined ? { treatingDoctorId: body.treatingDoctorId } : {}),
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
  }

  @Get()
  @RequirePermission(Permissions.CASE_VIEW)
  async list(
    @CurrentUser() user: Express.AuthenticatedUser,
    @Query('limit') limitRaw?: string,
    @Query('offset') offsetRaw?: string,
    @Query('status') status?: 'open' | 'closed' | 'abandoned',
  ): Promise<ListCasesResponse> {
    const limit = clamp(parseInt(limitRaw ?? '50', 10) || 50, 1, 200);
    const offset = Math.max(parseInt(offsetRaw ?? '0', 10) || 0, 0);
    return this.cases.list({
      tenantId: user.tenantId,
      limit,
      offset,
      ...(status ? { status } : {}),
    });
  }

  @Get(':id')
  @RequirePermission(Permissions.CASE_VIEW)
  async getById(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<CaseDetail> {
    return this.cases.getById(user.tenantId, id);
  }

  @Patch(':id')
  @RequirePermission(Permissions.CASE_ASSIGN)
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(UpdateCaseRequestSchema)) body: UpdateCaseRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
    @Req() req: Request,
  ): Promise<CaseDetail> {
    return this.cases.update({
      tenantId: user.tenantId,
      caseId: id,
      actorUserId: user.userId,
      ...(body.caseStatus !== undefined ? { caseStatus: body.caseStatus } : {}),
      ...(body.treatingDoctorId !== undefined ? { treatingDoctorId: body.treatingDoctorId } : {}),
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}
