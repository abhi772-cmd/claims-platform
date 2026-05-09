// Slice CG — DPDP §6 hard-enforcement domain error.
//
// Thrown by FhirContextService.build when:
//   tenant.requireConsent === true
//   AND the (patient, consentType) tuple has no active grant.
//
// 412 Precondition Failed (mirrors BIOMETRIC_VERIFICATION_REQUIRED's
// shape — same UX flow: pre-condition missing, frontend captures
// it, retries the original request). The problem-detail payload
// includes patientId + consentType so the consent-capture form
// can pre-populate.

import { ErrorCodes } from '@claims/error-codes';

import { DomainError } from './domain-error';

export class ConsentRequiredError extends DomainError {
  constructor(args: { patientId: string; consentType: string }) {
    super(ErrorCodes.CONSENT_REQUIRED, {
      detail: `Active '${args.consentType}' consent required before processing.`,
      // patientId + consentType land in problem.errors so the
      // frontend modal can pre-populate the consent-capture form.
      // The DomainError shape uses string-array values for fields,
      // matching the validation-error vocabulary; single-element
      // arrays are fine here.
      errors: {
        patientId: [args.patientId],
        consentType: [args.consentType],
      },
    });
  }
}
