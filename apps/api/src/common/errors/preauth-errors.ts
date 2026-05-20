// T1.1 — domain errors for the pre-auth checklist enforcement gate.

import { ErrorCodes } from '@claims/error-codes';

import { DomainError } from './domain-error';

// Thrown by PreauthService.submit when the resolved document checklist
// for this (phase=preauth, rail, payer, package, admissionType) marks
// one or more document types `required: true` that have not yet been
// uploaded (upload=completed + scan clean/skipped). Maps to HTTP 412 so
// the frontend treats it as a "do this first" precondition: it lists
// the missing types and routes the operator to the uploader, then
// retries the submit. The `errors.documents` array carries the missing
// documentType codes for the form; `detail` carries the human sentence.
export class PreauthDocumentsIncompleteError extends DomainError {
  constructor(missing: readonly string[]) {
    const list = missing.join(', ');
    super(ErrorCodes.PREAUTH_DOCUMENTS_INCOMPLETE, {
      detail:
        missing.length === 1
          ? `1 required document is missing: ${list}. Upload it to submit.`
          : `${missing.length} required documents are missing: ${list}. Upload these to submit.`,
      errors: { documents: [...missing] },
    });
  }
}
