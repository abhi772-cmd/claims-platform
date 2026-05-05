import { z } from 'zod';

import { DocumentTypeSchema } from './document.schema';

// =====================================================
// Payer
// =====================================================
export const PayerTypeSchema = z.enum([
  'private_tpa',
  'private_insurer',
  'pmjay_sha',
  'cghs',
  'self',
]);
export type PayerType = z.infer<typeof PayerTypeSchema>;

export const PayerRailSchema = z.enum(['nhcx', 'pmjay', 'self_pay']);
export type PayerRail = z.infer<typeof PayerRailSchema>;

export const PayerSchema = z.object({
  id: z.string().uuid(),
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  payerType: PayerTypeSchema,
  rail: PayerRailSchema,
  hcxCode: z.string().nullable(),
  active: z.boolean(),
  effectiveFrom: z.string().datetime(),
  effectiveTo: z.string().datetime().nullable(),
});
export type Payer = z.infer<typeof PayerSchema>;

export const CreatePayerRequestSchema = z.object({
  code: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[A-Z0-9_]+$/, 'Code must be UPPER_SNAKE'),
  name: z.string().min(1).max(200),
  payerType: PayerTypeSchema,
  rail: PayerRailSchema,
  hcxCode: z.string().max(120).optional(),
  effectiveFrom: z.string().datetime().optional(),
  effectiveTo: z.string().datetime().optional(),
});
export type CreatePayerRequest = z.infer<typeof CreatePayerRequestSchema>;

export const UpdatePayerRequestSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  payerType: PayerTypeSchema.optional(),
  rail: PayerRailSchema.optional(),
  hcxCode: z.string().max(120).nullable().optional(),
  active: z.boolean().optional(),
  effectiveTo: z.string().datetime().nullable().optional(),
});
export type UpdatePayerRequest = z.infer<typeof UpdatePayerRequestSchema>;

export const PayerListResponseSchema = z.object({
  payers: z.array(PayerSchema),
  total: z.number().int().nonnegative(),
});
export type PayerListResponse = z.infer<typeof PayerListResponseSchema>;

// =====================================================
// Package
// =====================================================
export const PackageSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  category: z.string().nullable(),
  amount: z.number().int().nonnegative(),
  pmjayHbp: z.boolean(),
  active: z.boolean(),
  effectiveFrom: z.string().datetime(),
  effectiveTo: z.string().datetime().nullable(),
});
export type Package = z.infer<typeof PackageSchema>;

export const CreatePackageRequestSchema = z.object({
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  category: z.string().max(120).optional(),
  amount: z.number().int().nonnegative(),
  pmjayHbp: z.boolean().optional(),
  effectiveFrom: z.string().datetime().optional(),
  effectiveTo: z.string().datetime().optional(),
});
export type CreatePackageRequest = z.infer<typeof CreatePackageRequestSchema>;

export const UpdatePackageRequestSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  category: z.string().max(120).nullable().optional(),
  amount: z.number().int().nonnegative().optional(),
  pmjayHbp: z.boolean().optional(),
  active: z.boolean().optional(),
  effectiveTo: z.string().datetime().nullable().optional(),
});
export type UpdatePackageRequest = z.infer<typeof UpdatePackageRequestSchema>;

export const PackageListResponseSchema = z.object({
  packages: z.array(PackageSchema),
  total: z.number().int().nonnegative(),
});
export type PackageListResponse = z.infer<typeof PackageListResponseSchema>;

// =====================================================
// ICD code
// =====================================================
export const IcdCodeSchema = z.object({
  code: z.string(),
  description: z.string(),
  chapter: z.string().nullable(),
  active: z.boolean(),
});
export type IcdCode = z.infer<typeof IcdCodeSchema>;

export const IcdCodeListResponseSchema = z.object({
  codes: z.array(IcdCodeSchema),
  total: z.number().int().nonnegative(),
});
export type IcdCodeListResponse = z.infer<typeof IcdCodeListResponseSchema>;

// =====================================================
// Billing code
// =====================================================
export const BillingCodeSchema = z.object({
  code: z.string(),
  description: z.string(),
  category: z.string().nullable(),
  baseAmount: z.number().int().nonnegative().nullable(),
  active: z.boolean(),
});
export type BillingCode = z.infer<typeof BillingCodeSchema>;

export const BillingCodeListResponseSchema = z.object({
  codes: z.array(BillingCodeSchema),
  total: z.number().int().nonnegative(),
});
export type BillingCodeListResponse = z.infer<typeof BillingCodeListResponseSchema>;

// =====================================================
// Document checklist rule
// =====================================================
export const ChecklistPhaseSchema = z.enum(['preauth', 'discharge', 'claim', 'all']);
export type ChecklistPhase = z.infer<typeof ChecklistPhaseSchema>;

export const ChecklistAdmissionTypeSchema = z.enum(['planned', 'emergency', 'day_care']);
export type ChecklistAdmissionType = z.infer<typeof ChecklistAdmissionTypeSchema>;

export const DocumentChecklistRuleSchema = z.object({
  id: z.string().uuid(),
  phase: ChecklistPhaseSchema,
  rail: PayerRailSchema,
  documentType: DocumentTypeSchema,
  required: z.boolean(),
  payerCode: z.string().nullable(),
  packageCode: z.string().nullable(),
  admissionType: ChecklistAdmissionTypeSchema.nullable(),
  conditions: z.record(z.unknown()),
  active: z.boolean(),
  effectiveFrom: z.string().datetime(),
  effectiveTo: z.string().datetime().nullable(),
});
export type DocumentChecklistRule = z.infer<typeof DocumentChecklistRuleSchema>;

export const CreateDocumentChecklistRuleRequestSchema = z.object({
  phase: ChecklistPhaseSchema,
  rail: PayerRailSchema,
  documentType: DocumentTypeSchema,
  required: z.boolean().optional(),
  payerCode: z.string().max(64).optional(),
  packageCode: z.string().max(64).optional(),
  admissionType: ChecklistAdmissionTypeSchema.optional(),
  conditions: z.record(z.unknown()).optional(),
  effectiveFrom: z.string().datetime().optional(),
  effectiveTo: z.string().datetime().optional(),
});
export type CreateDocumentChecklistRuleRequest = z.infer<
  typeof CreateDocumentChecklistRuleRequestSchema
>;

export const UpdateDocumentChecklistRuleRequestSchema = z.object({
  required: z.boolean().optional(),
  active: z.boolean().optional(),
  conditions: z.record(z.unknown()).optional(),
  effectiveTo: z.string().datetime().nullable().optional(),
});
export type UpdateDocumentChecklistRuleRequest = z.infer<
  typeof UpdateDocumentChecklistRuleRequestSchema
>;

export const DocumentChecklistRuleListResponseSchema = z.object({
  rules: z.array(DocumentChecklistRuleSchema),
  total: z.number().int().nonnegative(),
});
export type DocumentChecklistRuleListResponse = z.infer<
  typeof DocumentChecklistRuleListResponseSchema
>;

// Resolved checklist as shown to executive: one entry per documentType
// keyed against current claim phase + rail. Used by the documents UI.
export const ResolvedChecklistItemSchema = z.object({
  documentType: DocumentTypeSchema,
  required: z.boolean(),
  ruleId: z.string().uuid(),
});
export type ResolvedChecklistItem = z.infer<typeof ResolvedChecklistItemSchema>;

export const ResolvedChecklistResponseSchema = z.object({
  items: z.array(ResolvedChecklistItemSchema),
});
export type ResolvedChecklistResponse = z.infer<typeof ResolvedChecklistResponseSchema>;
