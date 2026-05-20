import { ValidationFailedError } from '../../common/errors/validation-errors';
import { type TenantPrisma } from '../../types/express';

// D-023 — the primary package always occupies sequence 1. Phase 1 only
// maintains this single line; implant / addon lines (sequence 2+) arrive
// with the Phase 3 multi-line UI.
const PRIMARY_SEQUENCE = 1;

export interface SyncPrimaryPackageParams {
  tenantId: string;
  claimId: string;
  // The claim's rail — stamped on the line so the FHIR builder (Phase 2)
  // knows which coding system to render the package under.
  rail: string;
  packageCode: string;
  // Operator override in paise. When null/undefined/non-positive the
  // line's requestedAmount is the package's fixed rate (D-023 auto-fill,
  // NOT a hard lock — enhancement / implant cases override).
  requestedAmountOverride?: number | null;
}

export interface SyncPrimaryPackageResult {
  // The requestedAmount the primary line ended up with. The caller
  // mirrors this onto the preauth draft so the form and the costing
  // spine never drift.
  requestedAmount: number;
  display: string;
  unitAmount: number;
}

// Maintain the PRIMARY (sequence 1) package line for a claim from the
// operator's package selection, and denormalise the code onto
// claim.packageCode. MUST run inside the caller's tenant transaction so
// the draft write + line write + claim update commit atomically.
export async function syncPrimaryPackageLine(
  tx: TenantPrisma,
  params: SyncPrimaryPackageParams,
): Promise<SyncPrimaryPackageResult> {
  const pkg = await tx.package.findUnique({ where: { code: params.packageCode } });
  if (!pkg || !pkg.active) {
    // Phase 1 validates against the seeded master. The seed is a thin
    // slice (~14 of ~1,949 HBPs); widening it (or relaxing to
    // known-or-freetext) is tracked under D-023's risk note.
    throw new ValidationFailedError({
      packageCode: ['Unknown or inactive package.'],
    });
  }

  const unitAmount = pkg.amount;
  const requestedAmount =
    params.requestedAmountOverride != null && params.requestedAmountOverride > 0
      ? params.requestedAmountOverride
      : unitAmount;

  await tx.claimLineItem.upsert({
    where: {
      claimId_sequence: { claimId: params.claimId, sequence: PRIMARY_SEQUENCE },
    },
    create: {
      tenantId: params.tenantId,
      claimId: params.claimId,
      lineType: 'package',
      code: pkg.code,
      display: pkg.name,
      rail: params.rail,
      unitAmount,
      quantity: 1,
      requestedAmount,
      lineStatus: 'requested',
      sequence: PRIMARY_SEQUENCE,
    },
    update: {
      code: pkg.code,
      display: pkg.name,
      rail: params.rail,
      unitAmount,
      requestedAmount,
    },
  });

  await tx.claim.update({
    where: { id: params.claimId },
    data: { packageCode: pkg.code },
  });

  return { requestedAmount, display: pkg.name, unitAmount };
}
