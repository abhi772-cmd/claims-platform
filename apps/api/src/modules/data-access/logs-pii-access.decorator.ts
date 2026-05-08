// Slice BR — declarative HTTP-level data access logging.
//
// Apply this decorator on controller methods that return PII-bearing
// data (audit list / export, patient view, case detail, etc.). The
// PiiAccessInterceptor reads the metadata after the handler resolves
// and writes a `data_access_event` row tagging actor + purpose +
// resourceType. We don't infer purpose from the route name — keep
// it explicit so the dashboard's group-by-purpose stays meaningful.

import { SetMetadata } from '@nestjs/common';

export interface LogsPiiAccessOptions {
  // Same vocabulary as DataAccessWriteInput.resourceType. Free-text
  // but conventional: 'audit_log' | 'patient' | 'case' | etc.
  resourceType: string;
  // 'list' | 'view' | 'export' — describes the shape of the read.
  // 'decrypt' is reserved for service-level recording at the
  // decryption point, not HTTP entry.
  action: 'list' | 'view' | 'export';
  // Why the operator hit this endpoint. 'manual_view' is the
  // typical operator-screen value; 'audit_query' /
  // 'audit_export' are conventional for the audit viewer; 'erasure_check'
  // for the erasure flow.
  purpose: string;
}

export const LOGS_PII_ACCESS_METADATA = 'logs-pii-access';

export const LogsPiiAccess = (opts: LogsPiiAccessOptions): MethodDecorator =>
  SetMetadata(LOGS_PII_ACCESS_METADATA, opts);
