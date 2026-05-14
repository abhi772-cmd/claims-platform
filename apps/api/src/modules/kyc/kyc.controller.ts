import {
  type KycDocument,
  type KycDownloadResponse,
  type KycListResponse,
  type KycUploadFinalizeRequest,
  KycUploadFinalizeRequestSchema,
  type KycUploadInitRequest,
  KycUploadInitRequestSchema,
  type KycUploadInitResponse,
  Permissions,
} from '@claims/contracts';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Request } from 'express';

import { KycService } from './kyc.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('tenant-kyc')
@Controller('tenant/kyc')
@UseGuards(JwtAuthGuard, RolesGuard)
export class KycController {
  constructor(private readonly kyc: KycService) {}

  @Get()
  @RequirePermission(Permissions.TENANT_ONBOARDING_UPDATE)
  async list(
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<KycListResponse> {
    return this.kyc.list(user.tenantId);
  }

  @Post('upload-init')
  @HttpCode(201)
  @RequirePermission(Permissions.TENANT_ONBOARDING_UPDATE)
  async uploadInit(
    @Body(new ZodValidationPipe(KycUploadInitRequestSchema)) body: KycUploadInitRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<KycUploadInitResponse> {
    return this.kyc.initUpload({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      documentType: body.documentType,
      originalFilename: body.originalFilename,
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
    });
  }

  @Post(':documentId/finalize')
  @HttpCode(200)
  @RequirePermission(Permissions.TENANT_ONBOARDING_UPDATE)
  async finalize(
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Body(new ZodValidationPipe(KycUploadFinalizeRequestSchema))
    body: KycUploadFinalizeRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
    @Req() req: Request,
  ): Promise<KycDocument> {
    return this.kyc.finalize({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      documentId,
      ...(body.contentSha256 !== undefined ? { contentSha256: body.contentSha256 } : {}),
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
  }

  @Delete(':documentId')
  @HttpCode(204)
  @RequirePermission(Permissions.TENANT_ONBOARDING_UPDATE)
  async remove(
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @CurrentUser() user: Express.AuthenticatedUser,
    @Req() req: Request,
  ): Promise<void> {
    await this.kyc.delete({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      documentId,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
  }

  @Get(':documentId/download-url')
  @RequirePermission(Permissions.TENANT_ONBOARDING_UPDATE)
  async downloadUrl(
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<KycDownloadResponse> {
    return this.kyc.getDownloadUrl(user.tenantId, documentId);
  }
}
