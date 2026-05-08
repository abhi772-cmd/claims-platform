// Slice BO — retention-class classifier unit tests. Locks the
// taxonomy + the safe-fallback contract so a future event addition
// either gets explicitly classified or visibly trips a test.

import { AuditEvents } from './audit.events';
import {
  ALL_RETENTION_CLASSES,
  classifyAuditEvent,
  RetentionClasses,
  RETENTION_FLOOR_DAYS,
} from './retention-classes';

describe('Slice BO — retention-class classifier', () => {
  describe('classifyAuditEvent — known events', () => {
    it.each([
      [AuditEvents.USER_LOGGED_IN, RetentionClasses.SESSION],
      [AuditEvents.USER_LOGGED_OUT, RetentionClasses.SESSION],
      [AuditEvents.SESSION_REVOKED, RetentionClasses.SESSION],

      [AuditEvents.USER_FAILED_LOGIN, RetentionClasses.SECURITY],
      [AuditEvents.USER_LOCKED, RetentionClasses.SECURITY],
      [AuditEvents.USER_PASSWORD_CHANGED, RetentionClasses.SECURITY],
      [AuditEvents.USER_MFA_ENROLLED, RetentionClasses.SECURITY],

      [AuditEvents.DOCTOR_SIGNATURE_REQUESTED, RetentionClasses.CLINICAL],
      [AuditEvents.DOCTOR_SIGNED, RetentionClasses.CLINICAL],

      [AuditEvents.USER_INVITED, RetentionClasses.GOVERNANCE],
      [AuditEvents.ROLE_ASSIGNED, RetentionClasses.GOVERNANCE],
      [AuditEvents.TENANT_NHCX_CONFIGURED, RetentionClasses.GOVERNANCE],
      [AuditEvents.TENANT_PMJAY_CONFIGURED, RetentionClasses.GOVERNANCE],
    ] as const)('%s → %s', (action, expected) => {
      expect(classifyAuditEvent(action)).toBe(expected);
    });
  });

  describe('safe fallback', () => {
    it('unknown action falls back to FINANCIAL (longest retention, conservative)', () => {
      expect(classifyAuditEvent('NEVER_DEFINED_EVENT')).toBe(RetentionClasses.FINANCIAL);
      expect(classifyAuditEvent('')).toBe(RetentionClasses.FINANCIAL);
    });
  });

  describe('coverage', () => {
    it('every defined AuditEvent has an explicit classification (no accidental fallthroughs)', () => {
      // The fallback exists for forward-compat, but every CURRENTLY
      // defined event must be in the static map. If you add a new
      // AuditEvent, classify it in retention-classes.ts at the same
      // time. This test catches the lapse.
      for (const action of Object.values(AuditEvents)) {
        const cls = classifyAuditEvent(action);
        // FINANCIAL is the safe fallback; we assert no current event
        // hits it by accident. Future financial events should use
        // FINANCIAL deliberately and will need this test updated.
        if (cls === RetentionClasses.FINANCIAL) {
          throw new Error(
            `Audit event ${action} fell through to the FINANCIAL fallback. Classify it in retention-classes.ts.`,
          );
        }
      }
    });
  });

  describe('taxonomy invariants', () => {
    it('ALL_RETENTION_CLASSES has six members', () => {
      expect(ALL_RETENTION_CLASSES).toHaveLength(6);
    });

    it('every class has a positive retention floor', () => {
      for (const cls of ALL_RETENTION_CLASSES) {
        expect(RETENTION_FLOOR_DAYS[cls]).toBeGreaterThan(0);
      }
    });

    it('financial is the longest floor (RBI 10y baseline)', () => {
      const max = Math.max(...ALL_RETENTION_CLASSES.map((c) => RETENTION_FLOOR_DAYS[c]));
      expect(RETENTION_FLOOR_DAYS.financial).toBe(max);
    });

    it('session is the shortest floor (DPDP transit, 90d)', () => {
      const min = Math.min(...ALL_RETENTION_CLASSES.map((c) => RETENTION_FLOOR_DAYS[c]));
      expect(RETENTION_FLOOR_DAYS.session).toBe(min);
      expect(RETENTION_FLOOR_DAYS.session).toBe(90);
    });

    it('clinical floor matches IRDAI 5y', () => {
      expect(RETENTION_FLOOR_DAYS.clinical).toBe(5 * 365);
    });

    it('financial floor matches RBI 10y', () => {
      expect(RETENTION_FLOOR_DAYS.financial).toBe(10 * 365);
    });
  });
});
