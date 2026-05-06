import {
  type Document,
  type DocumentListResponse,
  Permissions,
  type UploadDocumentStubRequest,
  UploadDocumentStubRequestSchema,
  type UploadFinalizeRequest,
  UploadFinalizeRequestSchema,
  type UploadInitRequest,
  UploadInitRequestSchema,
  type UploadInitResponse,
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
import { ApiTags } from '@nestjs/swagger';

import { DocumentService } from './document.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CaseService } from '../case';

@ApiTags('documents')
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

  // Legacy single-shot upload — synthesises storage refs + creates a
  // 'completed' row. Kept for tests + dev where STORAGE_MODE=stub. Real
  // clients should use upload-init + finalize.
  @Post('upload-stub')
  @HttpCode(201)
  @RequirePermission(Permissions.CASE_CREATE)
  async uploadStub(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body(new ZodValidationPipe(UploadDocumentStubRequestSchema))
    body: UploadDocumentStubRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<{ document: Document }> {
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

  // Two-step real upload: init → client PUTs bytes → finalize.
  @Post('upload-init')
  @HttpCode(201)
  @RequirePermission(Permissions.CASE_CREATE)
  async uploadInit(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body(new ZodValidationPipe(UploadInitRequestSchema)) body: UploadInitRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<UploadInitResponse> {
    await this.assertOwns(user.tenantId, caseId, claimId);
    return this.documents.initUpload({
      tenantId: user.tenantId,
      claimId,
      actorUserId: user.userId,
      documentType: body.documentType,
      originalFilename: body.originalFilename,
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
    });
  }

  @Post(':documentId/finalize')
  @HttpCode(200)
  @RequirePermission(Permissions.CASE_CREATE)
  async finalize(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Body(new ZodValidationPipe(UploadFinalizeRequestSchema)) body: UploadFinalizeRequest,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<{ document: Document }> {
    await this.assertOwns(user.tenantId, caseId, claimId);
    const scanBuffer =
      body.scanBufferBase64 !== undefined
        ? Buffer.from(body.scanBufferBase64, 'base64')
        : undefined;
    const document = await this.documents.finalizeUpload({
      tenantId: user.tenantId,
      claimId,
      documentId,
      ...(body.contentSha256 !== undefined ? { contentSha256: body.contentSha256 } : {}),
      ...(scanBuffer !== undefined ? { scanBuffer } : {}),
    });
    return { document };
  }

  private async assertOwns(tenantId: string, caseId: string, claimId: string): Promise<void> {
    const detail = await this.cases.getById(tenantId, caseId);
    const owns = detail.claims.some((c) => c.id === claimId);
    if (!owns) throw new ValidationFailedError({ claimId: ['Claim not on this case.'] });
  }
}
