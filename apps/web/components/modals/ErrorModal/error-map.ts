// Re-export the canonical presentation map from @claims/error-codes.
// This file exists so component code never has to know which package
// owns the lookup; it just imports from the local error-map.

export { ErrorPresentations as errorMap, type ErrorPresentation, type ErrorSeverity } from '@claims/error-codes';
export { ErrorCodes, type ErrorCode } from '@claims/error-codes';
