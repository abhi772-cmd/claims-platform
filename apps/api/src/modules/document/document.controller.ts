import {
  type DocumentListResponse,
  Permissions,
  type UploadDocumentStubRequest,
  UploadDocumentStubRequestSchema,
} from '@claims/contracts';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';

import { DocumentService } from './document.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CaseService } from '../case';

@Controller('cases/:caseId/claims/:claimId/documents')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DocumentController {
  constructor(
    private readonly documents: DocumentService,
    private readonly cases: CaseService,
  ) {}

  @Get()
  @RequirePermission(Permissions.CASE_VIEW)
  async list(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<DocumentListResponse> {
    await this.assertOwns(user.tenantId, caseId, claimId);
    const documents = await this.documents.list(user.tenantId, claimId);
    return { documents };
  }

  @Post('upload-stub')
  @HttpCode(201)
  @RequirePermission(Permissions.CASE_CREATE)
  async uploadStub(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body(new ZodValidationPipe(UploadDocumentStubRequestSchema))
    body: UploadDocumentStubRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<{ document: Awaited<ReturnType<DocumentService['uploadStub']>> }> {
    await this.assertOwns(user.tenantId, caseId, claimId);
    const document = await this.documents.uploadStub({
      tenantId: user.tenantId,
      claimId,
      actorUserId: user.userId,
      documentType: body.documentType,
      originalFilename: body.originalFilename,
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
    });
    return { document };
  }

  private async assertOwns(tenantId: string, caseId: string, claimId: string): Promise<void> {
    const detail = await this.cases.getById(tenantId, caseId);
    const owns = detail.claims.some((c) => c.id === claimId);
    if (!owns) throw new ValidationFailedError({ claimId: ['Claim not on this case.'] });
  }
}
