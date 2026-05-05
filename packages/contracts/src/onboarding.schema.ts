import { z } from 'zod';

// Canonical step keys. Adding a new step here is a breaking change because
// the readiness check + UI render off this list — keep it in sync with
// docs/14 Part 5 (onboarding wizard).
export const OnboardingStepKeySchema = z.enum([
  'tenant_profile',
  'roles_assigned',
  'nhcx_cert',
  'pmjay_state',
  'payer_master',
  'package_master',
  'notification_test',
  'legal_acceptance',
]);
export type OnboardingStepKey = z.infer<typeof OnboardingStepKeySchema>;

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
