import {
  type KycDocument,
  type KycReviewDetail,
  type KycReviewQueueQuery,
  KycReviewQueueQuerySchema,
  type KycReviewQueueResponse,
  type KycReviewRequest,
  KycReviewRequestSchema,
  Permissions,
} from '@claims/contracts';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
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

// Slice ON-3 — KYC review queue. Cross-tenant; platform_admin only.
// All routes gated on the `kyc.review` permission, which only the
// seeded `platform_admin` role carries (see seed.ts ROLE_SEEDS).
@ApiTags('admin-kyc-review')
@Controller('admin/kyc')
@UseGuards(JwtAuthGuard, RolesGuard)
export class KycReviewController {
  constructor(private readonly kyc: KycService) {}

  @Get('queue')
  @RequirePermission(Permissions.KYC_REVIEW)
  async queue(
    @Query(new ZodValidationPipe(KycReviewQueueQuerySchema)) query: KycReviewQueueQuery,
  ): Promise<KycReviewQueueResponse> {
    return this.kyc.queue(query);
  }

  @Get(':documentId')
  @RequirePermission(Permissions.KYC_REVIEW)
  async detail(
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
  ): Promise<KycReviewDetail> {
    return this.kyc.getForReview(documentId);
  }

  @Post(':documentId/review')
  @HttpCode(200)
  @RequirePermission(Permissions.KYC_REVIEW)
  async review(
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Body(new ZodValidationPipe(KycReviewRequestSchema)) body: KycReviewRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
    @Req() req: Request,
  ): Promise<KycDocument> {
    return this.kyc.review({
      documentId,
      reviewerUserId: user.userId,
      body,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
  }
}
