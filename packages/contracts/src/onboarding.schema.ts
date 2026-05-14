import { z } from 'zod';

// Canonical step keys. Adding a new step here is a breaking change because
// the readiness check + UI render off this list — keep it in sync with
// docs/14 Part 5 (onboarding wizard).
//
// NHCX-axis steps (`hfr_facility`, `nhcx_participant_code`,
// `nhcx_callback_url`, `nhcx_cert`) come straight from
// `docs/07-nhcx-and-pmjay.md:15–22`. Each one captures a discrete
// piece of NHCX participant identity that NHA's gateway will check
// before accepting any outbound message. Before Sprint 10 only
// `nhcx_cert` was tracked; the rest happened informally on email +
// spreadsheets, which (per GAP_ANALYSIS.md row 10) is the single
// largest reason hospitals fail NHCX sandbox certification.
export const OnboardingStepKeySchema = z.enum([
  'tenant_profile',
  'roles_assigned',
  // NHCX participant onboarding axis — order matters; each step
  // produces the input the next one needs:
  //   hfr_facility            → HFR ID (registered facility)
  //   nhcx_participant_code   → @hcx code issued by NHA
  //   nhcx_cert               → X.509 keypair + public key submitted
  //   nhcx_callback_url       → callback URL registered with NHA
  'hfr_facility',
  'nhcx_participant_code',
  'nhcx_cert',
  'nhcx_callback_url',
  // PMJAY axis (Sprint 7 BL onwards).
  'pmjay_state',
  // Master data + readiness probes.
  'payer_master',
  'package_master',
  'notification_test',
  // Slice ON-2 — Stage-3 KYC document uploads. The hospital uploads
  // the six KYC artefacts; the step auto-completes when every
  // required type has a non-rejected row.
  'kyc_documents_uploaded',
  // Slice ON-3 — Stage-3 legal agreements. DPA + MSA. Auto-completes
  // when both signed PDFs have non-rejected uploads.
  'legal_agreements_signed',
  // Slice ON-3 — derived from ops approvals. Auto-completes when
  // every required KYC + both legal agreements are in `approved`
  // state. The hospital cannot manually mark this step; the
  // wizard surfaces it as read-only.
  'kyc_verified_by_ops',
  'legal_acceptance',
]);
export type OnboardingStepKey = z.infer<typeof OnboardingStepKeySchema>;

// Static descriptors used by the readiness UI to explain each step's
// purpose, the data it captures, and where to perform the underlying
// action. Keeping this co-located with the enum means the UI cannot
// drift from the schema — adding a step here is a TypeScript error
// until the descriptor lands.
export interface OnboardingStepDescriptor {
  key: OnboardingStepKey;
  title: string;
  // One-sentence "why this matters" — surfaced as the step subtitle.
  purpose: string;
  // Concrete data captured by the step, listed for the UI.
  captures: string[];
  // Where the operator performs the underlying action when the step
  // isn't fulfilled by us. Used as a "How to complete" link target.
  externalAction?: { label: string; url: string };
  // True when NHA sandbox certification absolutely requires this
  // step before any outbound NHCX traffic can flow.
  blocksNhcxCutover: boolean;
  // Slice ON-3 — when true, the step's status is computed by the
  // server (e.g. `kyc_verified_by_ops` flips to completed only when
  // ops has approved every required KYC + legal upload). The wizard
  // surfaces these as read-only: no Mark complete button, no
  // tenant-side mutation path. Defaults to false.
  derivedByServer?: boolean;
}

export const ONBOARDING_STEP_DESCRIPTORS: ReadonlyArray<OnboardingStepDescriptor> = [
  {
    key: 'tenant_profile',
    title: 'Hospital profile',
    purpose: 'Tells the platform which hospital you are and what its rails are.',
    captures: [
      'Legal name',
      'ROHINI ID',
      'Hospital type (private / trust / government / PSU)',
      'Bed count',
      'HMIS in use',
      'Expected monthly claims volume band',
      'NHCX/PMJAY enablement flags',
      'Primary contact',
    ],
    blocksNhcxCutover: true,
  },
  {
    key: 'roles_assigned',
    title: 'Roles assigned',
    purpose: 'Ensures every workflow has someone responsible — MFA-enrolled admin, claims maker, claims checker, doctor.',
    captures: ['Admin user with MFA', 'At least one Claims Maker', 'At least one Claims Checker'],
    blocksNhcxCutover: true,
  },
  {
    key: 'hfr_facility',
    title: 'HFR facility registered',
    purpose: 'NHA only accepts NHCX traffic from hospitals listed in the Health Facility Registry. The HFR ID is the unforgeable identity NHA verifies on every call.',
    captures: ['HFR facility ID', 'Registration evidence screenshot', 'Verification timestamp via facility.abdm.gov.in'],
    externalAction: { label: 'Register or verify on facility.abdm.gov.in', url: 'https://facility.abdm.gov.in' },
    blocksNhcxCutover: true,
  },
  {
    key: 'nhcx_participant_code',
    title: 'NHCX participant code',
    purpose: 'Your `@hcx` identity. Sent on every outbound call as `x-hcx-sender-code`; embedded in every FHIR bundle.',
    captures: ['Participant code (e.g. example.hospital@hcx)', 'Issuance date', 'Sandbox vs production indicator'],
    externalAction: { label: 'Issued by NHA via the participant onboarding ticket', url: 'https://nhcx.abdm.gov.in/' },
    blocksNhcxCutover: true,
  },
  {
    key: 'nhcx_cert',
    title: 'X.509 keypair + public key submitted',
    purpose: 'NHA encrypts every callback to you with your public key; you sign every outbound call with your private key. Without this you cannot receive or send NHCX traffic.',
    captures: ['Public key fingerprint', 'Submission acknowledgement from NHA', 'KMS-wrapped private key reference'],
    blocksNhcxCutover: true,
  },
  {
    key: 'nhcx_callback_url',
    title: 'Callback URL registered',
    purpose: 'NHA pushes every async response (preauth/on_submit, claim/on_submit, paymentnotice/request) to the URL you register here.',
    captures: ['Callback base URL', 'NHA-side registration confirmation', 'Optional mTLS thumbprint'],
    externalAction: { label: 'Submit callback URL ticket to NHA', url: 'https://nhcx.abdm.gov.in/' },
    blocksNhcxCutover: true,
  },
  {
    key: 'pmjay_state',
    title: 'PMJAY state config',
    purpose: 'Selects which State Health Agency rules + portal flows apply for PMJAY cases at this hospital.',
    captures: ['Primary state (e.g. MP, UP)', 'Per-operation mode overrides', 'Portal credentials reference'],
    blocksNhcxCutover: false,
  },
  {
    key: 'payer_master',
    title: 'Payer master uploaded',
    purpose: 'List of insurers + TPAs this hospital deals with, mapped to their NHCX participant codes.',
    captures: ['Payer count', 'Each payer\'s @hcx code', 'Override list (custom turnaround promises)'],
    blocksNhcxCutover: true,
  },
  {
    key: 'package_master',
    title: 'Package master uploaded',
    purpose: 'Tariffs + package codes the hospital bills against. Required for line-level Claim.item[] population.',
    captures: ['Package/tariff CSV import', 'HBP package mapping for PMJAY', 'Last-updated timestamp'],
    blocksNhcxCutover: false,
  },
  {
    key: 'notification_test',
    title: 'Notification test',
    purpose: 'Smoke test that email + SMS notifications can be delivered to the configured recipients.',
    captures: ['Test email delivery', 'Test SMS delivery', 'Recipient acknowledgements'],
    blocksNhcxCutover: false,
  },
  {
    key: 'kyc_documents_uploaded',
    title: 'KYC documents uploaded',
    purpose:
      'NHA + IRDAI require six KYC artefacts per onboarded hospital. Each one is uploaded once, reviewed by DigiSparsh ops, and persists for the life of the tenant.',
    captures: [
      'Hospital registration certificate',
      'ROHINI registration proof',
      'GST certificate',
      'PAN',
      'Authorized signatory ID',
      'Cancelled cheque',
    ],
    blocksNhcxCutover: true,
  },
  {
    key: 'legal_agreements_signed',
    title: 'Legal agreements signed',
    purpose:
      'Data Processing Agreement (DPDP §11) + Master Services Agreement, signed by your authorized signatory. v1 flow is download the PDF, sign physically or via your own e-signature provider, re-upload.',
    captures: [
      'Signed DPA (DPDP-compliant)',
      'Signed MSA',
      'Signatory user reference',
    ],
    blocksNhcxCutover: true,
  },
  {
    key: 'kyc_verified_by_ops',
    title: 'KYC verified by DigiSparsh ops',
    purpose:
      'DigiSparsh ops reviews every uploaded KYC + legal artefact against your registration records. Lifecycle transitions to PILOT remain blocked until every required document is in `approved` state.',
    captures: [
      'Ops reviewer identity per document',
      'Approval timestamps',
      'Any rejection / resubmission reasons',
    ],
    blocksNhcxCutover: true,
    derivedByServer: true,
  },
  {
    key: 'legal_acceptance',
    title: 'Legal acceptance',
    purpose: 'Signs off on the platform terms + data-processing agreement and the NHA Healthcare Operation Policy.',
    captures: ['Signed DPA reference', 'NHA HOP acknowledgement', 'Signatory user'],
    blocksNhcxCutover: true,
  },
];

export const OnboardingStepStatusSchema = z.enum([
  'pending',
  'in_progress',
  'completed',
  'skipped',
]);
export type OnboardingStepStatus = z.infer<typeof OnboardingStepStatusSchema>;

export const OnboardingStepSchema = z.object({
  key: OnboardingStepKeySchema,
  status: OnboardingStepStatusSchema,
  completedAt: z.string().datetime().nullable(),
  // Free-form evidence — what the user / system attached to the step.
  // E.g. { 'pmjay_state': 'KA' } or { 'payer_count': 12 }.
  evidence: z.record(z.unknown()),
});
export type OnboardingStep = z.infer<typeof OnboardingStepSchema>;

export const OnboardingStepsResponseSchema = z.object({
  steps: z.array(OnboardingStepSchema),
});
export type OnboardingStepsResponse = z.infer<typeof OnboardingStepsResponseSchema>;

export const CompleteOnboardingStepRequestSchema = z.object({
  evidence: z.record(z.unknown()).optional(),
  // Defaults to 'completed'. 'skipped' is allowed for optional steps.
  status: OnboardingStepStatusSchema.optional(),
});
export type CompleteOnboardingStepRequest = z.infer<typeof CompleteOnboardingStepRequestSchema>;

// Readiness check — pure function over the current onboarding state.
// Items list maps 1:1 onto the onboarding steps, plus a few computed
// checks that don't have an explicit step (e.g. mfa-enrolled admin).
export const ReadinessItemSchema = z.object({
  key: z.string(),
  ok: z.boolean(),
  message: z.string(),
});
export type ReadinessItem = z.infer<typeof ReadinessItemSchema>;

export const ReadinessReportSchema = z.object({
  ready: z.boolean(),
  items: z.array(ReadinessItemSchema),
});
export type ReadinessReport = z.infer<typeof ReadinessReportSchema>;

// Lifecycle transition wire shapes. The TenantLifecycleState enum itself
// is exported from tenant.schema (it predates this file) — we re-use it.
import { TenantLifecycleStateSchema } from './tenant.schema';

export const LifecycleTransitionRequestSchema = z.object({
  target: TenantLifecycleStateSchema,
  reason: z.string().max(500).optional(),
});
export type LifecycleTransitionRequest = z.infer<typeof LifecycleTransitionRequestSchema>;

export const LifecycleStateResponseSchema = z.object({
  state: TenantLifecycleStateSchema,
  // Transitions the caller is allowed to take from the current state.
  allowedTargets: z.array(TenantLifecycleStateSchema),
});
export type LifecycleStateResponse = z.infer<typeof LifecycleStateResponseSchema>;
