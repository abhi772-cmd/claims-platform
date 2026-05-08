// Slice BN — local state for the PMJAY onboarding CLI. The flow has
// two natural pause points (operator waiting for SMS OTP), and the
// second OTP has a 24h TTL — so the operator may invoke the CLI on
// Monday to do create+validate, and again on Tuesday for
// update+update-validate. State persists between runs in a single
// JSON file the operator passes via --state-file.
//
// Private key material is NOT written here — it lives in a separate
// PEM file that the operator controls. State only carries the path.

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

import { z } from 'zod';

export const OnboardingStepSchema = z.enum([
  'pending_create',
  'awaiting_create_otp',
  'awaiting_update',
  'awaiting_update_otp',
  'completed',
]);
export type OnboardingStep = z.infer<typeof OnboardingStepSchema>;

export const OnboardingStateSchema = z.object({
  step: OnboardingStepSchema,
  // Inputs collected for the create call.
  registryid: z.string().optional(),
  mobilenumber: z.string().optional(),
  email: z.string().optional(),
  endpointurl: z.string().optional(),
  // Outputs from create.
  participantid: z.string().optional(),
  createTransactionId: z.string().optional(),
  // Update step.
  privateKeyPath: z.string().optional(),
  publicKeyPath: z.string().optional(),
  updateTransactionId: z.string().optional(),
  // Bookkeeping for ops.
  baseUrl: z.string().optional(),
  startedAt: z.string().optional(),
  lastUpdatedAt: z.string().optional(),
});
export type OnboardingState = z.infer<typeof OnboardingStateSchema>;

export function loadState(path: string): OnboardingState | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  if (raw.trim().length === 0) return null;
  const json = JSON.parse(raw) as unknown;
  // Throws if the file is corrupt or written by an older version.
  return OnboardingStateSchema.parse(json);
}

export function saveState(path: string, state: OnboardingState): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const next: OnboardingState = {
    ...state,
    lastUpdatedAt: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(next, null, 2), 'utf8');
  // 0600 — state contains transactionid which is sensitive enough
  // that we don't want a co-tenant on a shared box reading it. On
  // Windows this is a no-op; on POSIX it tightens permissions.
  try {
    chmodSync(path, 0o600);
  } catch {
    // chmod is best-effort; fail open on platforms that don't support it.
  }
}

export function emptyState(baseUrl: string): OnboardingState {
  const ts = new Date().toISOString();
  return {
    step: 'pending_create',
    baseUrl,
    startedAt: ts,
    lastUpdatedAt: ts,
  };
}
