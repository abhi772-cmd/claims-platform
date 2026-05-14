'use client';

// Stub placeholder so the dev build compiles. The real PlanPreviewCard
// belongs to an in-flight insurance-plan slice that hasn't landed yet.
// When that slice does land it will overwrite this file with the full
// implementation. Until then this renders nothing.
//
// Touched: cases/[id]/page.tsx imports + uses this component to surface
// the InsurancePlan/$discover round-trip result alongside the claim
// detail view. Rendering null keeps the page layout intact.

export interface PlanPreviewCardProps {
  caseId: string;
  claimId: string;
  defaultPolicyNumber?: string | null;
}

export function PlanPreviewCard(_props: PlanPreviewCardProps): JSX.Element | null {
  return null;
}
