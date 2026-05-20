import {
  type BillingCodeListResponse,
  ChecklistPhaseSchema,
  type CreateDocumentChecklistRuleRequest,
  CreateDocumentChecklistRuleRequestSchema,
  type CreatePackageRequest,
  CreatePackageRequestSchema,
  type CreatePayerRequest,
  CreatePayerRequestSchema,
  type DocumentChecklistRule,
  type DocumentChecklistRuleListResponse,
  type IcdCodeListResponse,
  type Package,
  type PackageListResponse,
  type Payer,
  type PayerListResponse,
  PayerRailSchema,
  type ResolvedChecklistResponse,
  type UpdateDocumentChecklistRuleRequest,
  UpdateDocumentChecklistRuleRequestSchema,
  type UpdatePackageRequest,
  UpdatePackageRequestSchema,
  type UpdatePayerRequest,
  UpdatePayerRequestSchema,
  Permissions,
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
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { MasterDataService, type ReadCtx } from './master-data.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

const ListPayersQuerySchema = z.object({
  rail: PayerRailSchema.optional(),
  active: z
    .union([z.literal('true'), z.literal('false')])
    .transform((v) => v === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const ListPackagesQuerySchema = z.object({
  // Typeahead search over package code + name (D-023 picker).
  q: z.string().max(120).optional(),
  category: z.string().optional(),
  pmjayHbp: z
    .union([z.literal('true'), z.literal('false')])
    .transform((v) => v === 'true')
    .optional(),
  active: z
    .union([z.literal('true'), z.literal('false')])
    .transform((v) => v === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const ListIcdQuerySchema = z.object({
  q: z.string().max(120).optional(),
  active: z
    .union([z.literal('true'), z.literal('false')])
    .transform((v) => v === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const ListBillingQuerySchema = z.object({
  category: z.string().optional(),
  active: z
    .union([z.literal('true'), z.literal('false')])
    .transform((v) => v === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const ListChecklistRulesQuerySchema = z.object({
  phase: ChecklistPhaseSchema.optional(),
  rail: PayerRailSchema.optional(),
  active: z
    .union([z.literal('true'), z.literal('false')])
    .transform((v) => v === 'true')
    .optional(),
});

const ResolveChecklistQuerySchema = z.object({
  phase: ChecklistPhaseSchema,
  rail: PayerRailSchema,
  payerCode: z.string().max(64).optional(),
  packageCode: z.string().max(64).optional(),
  admissionType: z.enum(['planned', 'emergency', 'day_care']).optional(),
});

@ApiTags('master-data')
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class MasterDataController {
  constructor(private readonly master: MasterDataService) {}

  // Master-data SELECT policies accept any non-empty role GUC, so we just
  // pass the caller's authenticated role through. Writes are enforced by
  // the @RequirePermission decorator + the service-level platform_admin
  // GUC binding.
  private ctxFor(user: Express.AuthenticatedUser): ReadCtx {
    return { tenantId: user.tenantId, role: user.role };
  }

  // ----- Payer ------------------------------------------------------

  @Get('payers')
  @RequirePermission(Permissions.PAYER_MASTER_VIEW)
  async listPayers(
    @Query(new ZodValidationPipe(ListPayersQuerySchema))
    q: z.infer<typeof ListPayersQuerySchema>,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<PayerListResponse> {
    return this.master.listPayers(this.ctxFor(user), q);
  }

  @Get('payers/:id')
  @RequirePermission(Permissions.PAYER_MASTER_VIEW)
  async getPayer(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<{ payer: Payer }> {
    const payer = await this.master.getPayer(this.ctxFor(user), id);
    if (!payer) throw new ValidationFailedError({ id: ['Payer not found.'] });
    return { payer };
  }

  @Post('payers')
  @HttpCode(201)
  @RequirePermission(Permissions.PAYER_MASTER_EDIT)
  async createPayer(
    @Body(new ZodValidationPipe(CreatePayerRequestSchema)) body: CreatePayerRequest,
  ): Promise<{ payer: Payer }> {
    const payer = await this.master.createPayer(body);
    return { payer };
  }

  @Patch('payers/:id')
  @RequirePermission(Permissions.PAYER_MASTER_EDIT)
  async updatePayer(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(UpdatePayerRequestSchema)) body: UpdatePayerRequest,
  ): Promise<{ payer: Payer }> {
    const payer = await this.master.updatePayer(id, body);
    return { payer };
  }

  // ----- Package ----------------------------------------------------

  @Get('packages')
  @RequirePermission(Permissions.PAYER_MASTER_VIEW)
  async listPackages(
    @Query(new ZodValidationPipe(ListPackagesQuerySchema))
    q: z.infer<typeof ListPackagesQuerySchema>,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<PackageListResponse> {
    return this.master.listPackages(this.ctxFor(user), q);
  }

  @Post('packages')
  @HttpCode(201)
  @RequirePermission(Permissions.PACKAGE_MASTER_SYNC)
  async createPackage(
    @Body(new ZodValidationPipe(CreatePackageRequestSchema)) body: CreatePackageRequest,
  ): Promise<{ package: Package }> {
    const pkg = await this.master.createPackage(body);
    return { package: pkg };
  }

  @Patch('packages/:id')
  @RequirePermission(Permissions.PACKAGE_MASTER_SYNC)
  async updatePackage(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(UpdatePackageRequestSchema)) body: UpdatePackageRequest,
  ): Promise<{ package: Package }> {
    const pkg = await this.master.updatePackage(id, body);
    return { package: pkg };
  }

  // ----- ICD codes --------------------------------------------------

  @Get('icd-codes')
  @RequirePermission(Permissions.PAYER_MASTER_VIEW)
  async listIcd(
    @Query(new ZodValidationPipe(ListIcdQuerySchema)) q: z.infer<typeof ListIcdQuerySchema>,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<IcdCodeListResponse> {
    return this.master.listIcd(this.ctxFor(user), q);
  }

  // ----- Billing codes ----------------------------------------------

  @Get('billing-codes')
  @RequirePermission(Permissions.PAYER_MASTER_VIEW)
  async listBilling(
    @Query(new ZodValidationPipe(ListBillingQuerySchema))
    q: z.infer<typeof ListBillingQuerySchema>,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<BillingCodeListResponse> {
    return this.master.listBilling(this.ctxFor(user), q);
  }

  // ----- Document checklist rules -----------------------------------

  @Get('document-checklist-rules')
  @RequirePermission(Permissions.DOCUMENT_CHECKLIST_EDIT)
  async listRules(
    @Query(new ZodValidationPipe(ListChecklistRulesQuerySchema))
    q: z.infer<typeof ListChecklistRulesQuerySchema>,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<DocumentChecklistRuleListResponse> {
    return this.master.listChecklistRules(this.ctxFor(user), q);
  }

  @Post('document-checklist-rules')
  @HttpCode(201)
  @RequirePermission(Permissions.DOCUMENT_CHECKLIST_EDIT)
  async createRule(
    @Body(new ZodValidationPipe(CreateDocumentChecklistRuleRequestSchema))
    body: CreateDocumentChecklistRuleRequest,
  ): Promise<{ rule: DocumentChecklistRule }> {
    const rule = await this.master.createChecklistRule(body);
    return { rule };
  }

  @Patch('document-checklist-rules/:id')
  @RequirePermission(Permissions.DOCUMENT_CHECKLIST_EDIT)
  async updateRule(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(UpdateDocumentChecklistRuleRequestSchema))
    body: UpdateDocumentChecklistRuleRequest,
  ): Promise<{ rule: DocumentChecklistRule }> {
    const rule = await this.master.updateChecklistRule(id, body);
    return { rule };
  }

  @Get('document-checklist-rules/resolve')
  @RequirePermission(Permissions.PAYER_MASTER_VIEW)
  async resolveRules(
    @Query(new ZodValidationPipe(ResolveChecklistQuerySchema))
    q: z.infer<typeof ResolveChecklistQuerySchema>,
    @CurrentUser() user: Express.AuthenticatedUser,
  ): Promise<ResolvedChecklistResponse> {
    const items = await this.master.resolveChecklist(this.ctxFor(user), q);
    return { items };
  }
}
