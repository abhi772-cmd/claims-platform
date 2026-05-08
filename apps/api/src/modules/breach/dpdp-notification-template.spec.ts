// Slice BS — DPDP §8(6) notification template renderer unit tests.

import {
  DPDP_NOTIFICATION_WINDOW_MS,
  renderDpdpNotification,
} from './dpdp-notification-template';

describe('renderDpdpNotification', () => {
  const baseInput = {
    incidentId: '11111111-1111-4111-8111-111111111111',
    tenantSlug: 'apollo-mumbai',
    tenantDisplayName: 'Apollo Hospital — Mumbai',
    grievanceOfficerContact: 'dpo@apollo-mumbai.example.in',
    severity: 'high' as const,
    openedAt: new Date('2026-05-08T10:00:00.000Z'),
    dueAt: new Date('2026-05-11T10:00:00.000Z'),
    description: 'Operator decrypted 200 distinct patients in 30 minutes.',
    affectedDataPrincipals: 200,
    dataCategories: ['aadhaar', 'mobile'],
  };

  it('72h window equals 72 * 60 * 60 * 1000 ms', () => {
    expect(DPDP_NOTIFICATION_WINDOW_MS).toBe(72 * 60 * 60 * 1000);
  });

  it('emits all six §8(6) sections with the inputs interpolated', () => {
    const out = renderDpdpNotification({ ...baseInput, kind: 'BURST_DECRYPT' });
    expect(out.subject).toContain('DPDP §8(6)');
    expect(out.subject).toContain('HIGH');
    expect(out.subject).toContain('Apollo Hospital');

    expect(out.body).toContain('1. Description of the breach');
    expect(out.body).toContain('Operator decrypted 200 distinct patients');
    expect(out.body).toContain('2. Approximate number of data principals affected');
    expect(out.body).toMatch(/200/);
    expect(out.body).toContain('3. Categories of personal data implicated');
    expect(out.body).toContain('aadhaar, mobile');
    expect(out.body).toContain('4. Likely consequences for affected principals');
    expect(out.body).toContain('5. Mitigation measures taken or planned');
    expect(out.body).toContain('6. Grievance officer contact');
    expect(out.body).toContain('dpo@apollo-mumbai.example.in');
  });

  it('falls back to a placeholder grievance contact when none is supplied', () => {
    const out = renderDpdpNotification({
      ...baseInput,
      grievanceOfficerContact: null,
      kind: 'BURST_DECRYPT',
    });
    expect(out.body).toContain('grievance officer contact pending');
    expect(out.fields.grievanceOfficerContact).toContain('grievance officer contact pending');
  });

  it('uses the BURST_DECRYPT-specific consequences + mitigations copy', () => {
    const out = renderDpdpNotification({ ...baseInput, kind: 'BURST_DECRYPT' });
    expect(out.fields.likelyConsequences).toContain('unusually large volume');
    expect(out.fields.mitigationMeasures).toContain('flagged for review');
  });

  it('uses the MANUAL_REPORT pass-through copy', () => {
    const out = renderDpdpNotification({ ...baseInput, kind: 'MANUAL_REPORT' });
    expect(out.fields.likelyConsequences).toContain('See incident description');
    expect(out.fields.mitigationMeasures).toContain('See incident description');
  });

  it('round-trips structured fields with ISO timestamps', () => {
    const out = renderDpdpNotification({ ...baseInput, kind: 'BURST_DECRYPT' });
    expect(out.fields.openedAt).toBe('2026-05-08T10:00:00.000Z');
    expect(out.fields.dueAt).toBe('2026-05-11T10:00:00.000Z');
    expect(out.fields.dataCategories).toEqual(['aadhaar', 'mobile']);
    expect(out.fields.affectedDataPrincipals).toBe(200);
  });
});
