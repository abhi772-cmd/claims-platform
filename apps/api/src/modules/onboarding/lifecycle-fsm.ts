import { type TenantLifecycleState as ContractState } from '@claims/contracts';
import { type TenantLifecycleState } from '@prisma/client';

// Tenant lifecycle FSM. Edges encode the *only* transitions the platform
// allows; everything else is rejected with TENANT_LIFECYCLE_TRANSITION_INVALID.
//
//   CONTRACTED → PROVISIONING → IN_SETUP → PILOT → LIVE
//   LIVE ↔ SUSPENDED         (recoverable)
//   PILOT → CHURNED          (terminal, e.g. paused before go-live)
//   LIVE → CHURNED           (terminal)
//
// Transitions to PILOT or LIVE additionally require the readiness check
// to pass — ReadinessService runs as a precondition; the FSM here only
// owns the topology.
const EDGES: Readonly<Record<TenantLifecycleState, readonly TenantLifecycleState[]>> = {
  CONTRACTED:   ['PROVISIONING'],
  PROVISIONING: ['IN_SETUP'],
  IN_SETUP:     ['PILOT'],
  PILOT:        ['LIVE', 'CHURNED'],
  LIVE:         ['SUSPENDED', 'CHURNED'],
  SUSPENDED:    ['LIVE'],
  CHURNED:      [],
};

// Transitions where we require ReadinessReport.ready === true. The FSM
// itself doesn't know about readiness; the lifecycle service consults
// this set when applying a transition.
export const READINESS_GATED_TARGETS: ReadonlySet<TenantLifecycleState> = new Set([
  'PILOT',
  'LIVE',
]);

export function allowedTargets(from: TenantLifecycleState): readonly TenantLifecycleState[] {
  return EDGES[from] ?? [];
}

export function isTransitionAllowed(
  from: TenantLifecycleState,
  to: TenantLifecycleState,
): boolean {
  return allowedTargets(from).includes(to);
}

// Type alias so callers don't have to import both shapes — the contract
// enum and the prisma enum are structurally identical.
export type LifecycleState = ContractState;
