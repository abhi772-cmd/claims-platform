// Case-trail generator for the demo walkthrough. Imported by
// seed-demo-walkthrough.ts — emits N cases per tenant with claim,
// claim_event trail, integration_message trail, and (where
// appropriate) settlement / preauth_query / appeal / bill_line_item
// rows so every operator panel has data to show.
//
// All money columns are paise (Int). Amounts here are demo-sized
// (Rs 50k – Rs 5L typical) so the variance dashboard renders
// realistic gaps without overflowing tabular-num cells.

import { Prisma } from '@prisma/client';

// ---------- Reference data ----------

const FIRST_NAMES_M = [
  'Rakesh', 'Mohit', 'Arun', 'Vikas', 'Karan', 'Sanjay', 'Ashok', 'Rajat',
  'Suresh', 'Manoj', 'Deepak', 'Amit', 'Rohit', 'Pawan', 'Kabir', 'Aditya',
  'Nikhil', 'Harsh', 'Yash', 'Ishaan',
];
const FIRST_NAMES_F = [
  'Anita', 'Priya', 'Sneha', 'Kavita', 'Pooja', 'Meena', 'Sunita', 'Rekha',
  'Lakshmi', 'Geeta', 'Nisha', 'Shilpa', 'Divya', 'Riya', 'Tanvi', 'Saanvi',
  'Aarti', 'Komal', 'Suman', 'Aishwarya',
];
const SURNAMES = [
  'Sharma', 'Kumar', 'Desai', 'Iyer', 'Patel', 'Singh', 'Mehta', 'Kapoor',
  'Rao', 'Reddy', 'Nair', 'Pillai', 'Joshi', 'Shah', 'Khanna', 'Verma',
  'Gupta', 'Agarwal', 'Bansal', 'Bhat',
];

// Payer codes that exist in the master data (per seed-master-data.ts).
// We mix them across tenants based on rail.
const NHCX_PAYERS = [
  { code: 'STAR', name: 'Star Health' },
  { code: 'HDFC', name: 'HDFC Ergo' },
  { code: 'BAJAJ', name: 'Bajaj Allianz' },
  { code: 'ICICI', name: 'ICICI Lombard' },
  { code: 'NIVA', name: 'Niva Bupa' },
];
const PMJAY_PAYERS = [
  { code: 'pmjay@hcx', name: 'PMJAY (NHA)' },
];

// SNOMED procedure codes + plain-English label for clinical realism
// on preauth bundles. Random pick when stamping a preauth draft.
const PROCEDURES = [
  { code: '80146002', name: 'Appendectomy', basePaise: 12500000 },
  { code: '737481003', name: 'Coronary angioplasty', basePaise: 38000000 },
  { code: '230690007', name: 'Cataract surgery', basePaise: 6500000 },
  { code: '69327004', name: 'Cesarean section', basePaise: 18500000 },
  { code: '52734007', name: 'Total hip replacement', basePaise: 52000000 },
  { code: '274401005', name: 'Laparoscopic cholecystectomy', basePaise: 14500000 },
  { code: '397956004', name: 'Kidney transplant', basePaise: 185000000 },
  { code: '386637004', name: 'Chemotherapy regimen', basePaise: 28500000 },
  { code: '108241001', name: 'Dialysis session', basePaise: 4500000 },
  { code: '281090004', name: 'COVID-19 inpatient care', basePaise: 8500000 },
];

const DIAGNOSIS_CODES = [
  { code: 'K35.80', name: 'Acute appendicitis' },
  { code: 'I25.10', name: 'Atherosclerotic heart disease' },
  { code: 'H25.9', name: 'Senile cataract' },
  { code: 'O82', name: 'Single delivery by cesarean section' },
  { code: 'M16.0', name: 'Bilateral primary osteoarthritis of hip' },
  { code: 'K80.20', name: 'Calculus of gallbladder' },
  { code: 'N18.6', name: 'End stage renal disease' },
  { code: 'C50.9', name: 'Malignant neoplasm of breast' },
  { code: 'U07.1', name: 'COVID-19' },
];

// ---------- Types ----------

type Rail = 'nhcx' | 'pmjay' | 'self_pay';

export interface SeedCasesInput {
  tenantId: string;
  tenantSlug: string;
  caseCount: number;
  rails: Rail[];
  actorUserIds: string[];
}

type ClaimStatus =
  | 'INITIATED'
  | 'ELIGIBILITY_CHECK_PENDING'
  | 'ELIGIBILITY_VERIFIED'
  | 'ELIGIBILITY_FAILED'
  | 'PREAUTH_DRAFTING'
  | 'PREAUTH_QUEUED'
  | 'PREAUTH_SUBMITTED'
  | 'PREAUTH_QUERY_RAISED'
  | 'PREAUTH_QUERY_RESPONDED'
  | 'PREAUTH_APPROVED'
  | 'PREAUTH_REJECTED'
  | 'PREAUTH_PARTIALLY_APPROVED'
  | 'PREAUTH_CANCELLED'
  | 'ENHANCEMENT_DRAFTING'
  | 'ENHANCEMENT_QUEUED'
  | 'ENHANCEMENT_SUBMITTED'
  | 'ENHANCEMENT_APPROVED'
  | 'ENHANCEMENT_REJECTED'
  | 'DISCHARGE_PENDING'
  | 'DISCHARGE_SUBMITTED'
  | 'CLAIM_DRAFTING'
  | 'CLAIM_QUEUED'
  | 'CLAIM_SUBMITTED'
  | 'CLAIM_QUERY_RAISED'
  | 'CLAIM_QUERY_RESPONDED'
  | 'CLAIM_APPROVED'
  | 'CLAIM_REJECTED'
  | 'CLAIM_PARTIALLY_APPROVED'
  | 'CLAIM_REPROCESS_REQUESTED'
  | 'PAYMENT_PENDING'
  | 'PAYMENT_RECEIVED'
  | 'PAYMENT_RECONCILED'
  | 'SHORT_PAID'
  | 'WRITTEN_OFF'
  | 'APPEAL_INITIATED'
  | 'APPEAL_SUBMITTED'
  | 'ABANDONED';

interface CaseTemplate {
  status: ClaimStatus;
  // How many cases to emit at this status. Tenants with smaller
  // caseCount get proportionally scaled down.
  count: number;
  rails?: Rail[]; // restrict to specific rails (e.g. CANCELLED is PMJAY-only)
  daysAgoMin: number;
  daysAgoMax: number;
}

// Distribution covering every status. Tenants with smaller caseCount
// scale this down proportionally. Apollo (60) gets ~the full set;
// Narayana / AIIMS (40 each) get fewer per status; Fortis (5) gets
// only closed states.
const FULL_DISTRIBUTION: CaseTemplate[] = [
  { status: 'INITIATED', count: 1, daysAgoMin: 0, daysAgoMax: 1 },
  { status: 'ELIGIBILITY_CHECK_PENDING', count: 1, daysAgoMin: 0, daysAgoMax: 1 },
  { status: 'ELIGIBILITY_VERIFIED', count: 2, daysAgoMin: 0, daysAgoMax: 2 },
  { status: 'ELIGIBILITY_FAILED', count: 1, daysAgoMin: 1, daysAgoMax: 3 },
  { status: 'PREAUTH_DRAFTING', count: 2, daysAgoMin: 0, daysAgoMax: 2 },
  { status: 'PREAUTH_QUEUED', count: 1, daysAgoMin: 0, daysAgoMax: 1 },
  { status: 'PREAUTH_SUBMITTED', count: 2, daysAgoMin: 1, daysAgoMax: 3 },
  { status: 'PREAUTH_QUERY_RAISED', count: 2, daysAgoMin: 1, daysAgoMax: 4 },
  { status: 'PREAUTH_QUERY_RESPONDED', count: 1, daysAgoMin: 2, daysAgoMax: 5 },
  { status: 'PREAUTH_APPROVED', count: 4, daysAgoMin: 2, daysAgoMax: 10 },
  { status: 'PREAUTH_REJECTED', count: 2, daysAgoMin: 3, daysAgoMax: 12 },
  { status: 'PREAUTH_PARTIALLY_APPROVED', count: 3, daysAgoMin: 2, daysAgoMax: 10 },
  { status: 'PREAUTH_CANCELLED', count: 1, rails: ['pmjay'], daysAgoMin: 3, daysAgoMax: 8 },
  { status: 'ENHANCEMENT_DRAFTING', count: 1, daysAgoMin: 4, daysAgoMax: 7 },
  { status: 'ENHANCEMENT_QUEUED', count: 1, daysAgoMin: 5, daysAgoMax: 8 },
  { status: 'ENHANCEMENT_SUBMITTED', count: 1, daysAgoMin: 5, daysAgoMax: 9 },
  { status: 'ENHANCEMENT_APPROVED', count: 2, daysAgoMin: 6, daysAgoMax: 12 },
  { status: 'ENHANCEMENT_REJECTED', count: 1, daysAgoMin: 6, daysAgoMax: 14 },
  { status: 'DISCHARGE_PENDING', count: 2, daysAgoMin: 4, daysAgoMax: 10 },
  { status: 'DISCHARGE_SUBMITTED', count: 2, daysAgoMin: 5, daysAgoMax: 12 },
  { status: 'CLAIM_DRAFTING', count: 1, daysAgoMin: 6, daysAgoMax: 14 },
  { status: 'CLAIM_QUEUED', count: 1, daysAgoMin: 7, daysAgoMax: 15 },
  { status: 'CLAIM_SUBMITTED', count: 2, daysAgoMin: 8, daysAgoMax: 18 },
  { status: 'CLAIM_QUERY_RAISED', count: 1, daysAgoMin: 10, daysAgoMax: 20 },
  { status: 'CLAIM_QUERY_RESPONDED', count: 1, daysAgoMin: 12, daysAgoMax: 22 },
  { status: 'CLAIM_APPROVED', count: 3, daysAgoMin: 14, daysAgoMax: 28 },
  { status: 'CLAIM_REJECTED', count: 2, daysAgoMin: 16, daysAgoMax: 30 },
  { status: 'CLAIM_PARTIALLY_APPROVED', count: 3, daysAgoMin: 14, daysAgoMax: 30 },
  { status: 'CLAIM_REPROCESS_REQUESTED', count: 1, daysAgoMin: 20, daysAgoMax: 40 },
  { status: 'PAYMENT_PENDING', count: 2, daysAgoMin: 16, daysAgoMax: 30 },
  { status: 'PAYMENT_RECEIVED', count: 3, daysAgoMin: 20, daysAgoMax: 40 },
  { status: 'PAYMENT_RECONCILED', count: 3, daysAgoMin: 25, daysAgoMax: 50 },
  { status: 'SHORT_PAID', count: 3, daysAgoMin: 22, daysAgoMax: 45 },
  { status: 'WRITTEN_OFF', count: 1, daysAgoMin: 35, daysAgoMax: 60 },
  { status: 'APPEAL_INITIATED', count: 1, daysAgoMin: 25, daysAgoMax: 35 },
  { status: 'APPEAL_SUBMITTED', count: 1, daysAgoMin: 28, daysAgoMax: 40 },
  { status: 'ABANDONED', count: 1, daysAgoMin: 20, daysAgoMax: 45 },
];

// ---------- Helpers ----------

function rand<T>(arr: readonly T[]): T {
  const idx = Math.floor(Math.random() * arr.length);
  const v = arr[idx];
  if (v === undefined) throw new Error('rand: empty array');
  return v;
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

function pickPayer(rail: Rail): { code: string; name: string } {
  if (rail === 'pmjay') return rand(PMJAY_PAYERS);
  if (rail === 'nhcx') return rand(NHCX_PAYERS);
  // self_pay — no payer, but stamp a placeholder for the column.
  return { code: 'SELF', name: 'Self-pay' };
}

function scaleDistribution(
  base: CaseTemplate[],
  targetCount: number,
  rails: Rail[],
): CaseTemplate[] {
  const filtered = base.filter((t) => !t.rails || t.rails.some((r) => rails.includes(r)));
  const baseTotal = filtered.reduce((acc, t) => acc + t.count, 0);
  const scale = targetCount / baseTotal;
  const scaled: CaseTemplate[] = filtered.map((t) => ({
    ...t,
    count: Math.max(1, Math.round(t.count * scale)),
  }));
  return scaled;
}

// ---------- Patient generation ----------

interface PatientRow {
  id: string;
  fullName: string;
  gender: 'male' | 'female';
}

async function ensurePatients(
  tx: Prisma.TransactionClient,
  tenantId: string,
  count: number,
): Promise<PatientRow[]> {
  const patients: PatientRow[] = [];
  for (let i = 0; i < count; i += 1) {
    const gender = Math.random() < 0.5 ? 'female' : 'male';
    const first = gender === 'female' ? rand(FIRST_NAMES_F) : rand(FIRST_NAMES_M);
    const last = rand(SURNAMES);
    const dobYear = 1940 + Math.floor(Math.random() * 70);
    const dobMonth = Math.floor(Math.random() * 12);
    const dobDay = 1 + Math.floor(Math.random() * 28);
    const created = await tx.patient.create({
      data: {
        tenantId,
        fullName: `${first} ${last}`,
        dateOfBirth: new Date(Date.UTC(dobYear, dobMonth, dobDay)),
        gender,
        // The crypto columns are non-null required — for demo we
        // stamp placeholder ciphers. The web app shows the
        // plaintext name above, never the cipher.
        aadhaarCipher: `cipher-aadhaar-demo-${i}`,
        aadhaarKeyVersion: 'v1',
        mobileCipher: `cipher-mobile-demo-${i}`,
        mobileKeyVersion: 'v1',
      },
      select: { id: true, fullName: true, gender: true },
    });
    patients.push({
      id: created.id,
      fullName: created.fullName,
      gender: created.gender === 'female' ? 'female' : 'male',
    });
  }
  return patients;
}

// ---------- Case generation ----------

interface CaseGenContext {
  tenantId: string;
  tenantSlug: string;
  patient: PatientRow;
  actorUserId: string;
  rail: Rail;
  template: CaseTemplate;
}

const MRN_PREFIX_BY_SLUG: Record<string, string> = {
  'apollo-mumbai': 'APMH',
  'narayana-bangalore': 'NRYN',
  'aiims-delhi': 'AIMS',
  'fortis-chennai': 'FRTC',
};

function mrnFor(slug: string, n: number): string {
  const prefix = MRN_PREFIX_BY_SLUG[slug] ?? 'DSPH';
  return `${prefix}-${String(n).padStart(6, '0')}`;
}

// Generates the claim_event sequence appropriate for the target
// final status. Each event row gets a sequential prevEventId so the
// chain reconstructs cleanly. Returns the number of events written
// (so the integration messages can reference the same correlation
// IDs roughly in time-order).
async function writeEventTrail(
  tx: Prisma.TransactionClient,
  tenantId: string,
  claimId: string,
  status: ClaimStatus,
  admissionAt: Date,
  actorUserId: string,
): Promise<string> {
  const events: Array<{ eventType: string; resultingStatus: string; offsetMs: number; payload?: Prisma.InputJsonValue }> = [];

  // Build the trail by progressively layering segments that should
  // exist for this final status. Times are offsets in ms from the
  // admission timestamp.
  events.push({ eventType: 'case.created', resultingStatus: 'INITIATED', offsetMs: 0 });

  const post = (s: ClaimStatus): boolean => CLAIM_PROGRESSION[status] >= CLAIM_PROGRESSION[s];

  if (post('ELIGIBILITY_CHECK_PENDING')) {
    events.push({ eventType: 'eligibility.requested', resultingStatus: 'ELIGIBILITY_CHECK_PENDING', offsetMs: 15 * 60_000 });
  }
  if (post('ELIGIBILITY_VERIFIED') && status !== 'ELIGIBILITY_FAILED') {
    events.push({ eventType: 'eligibility.verified', resultingStatus: 'ELIGIBILITY_VERIFIED', offsetMs: 30 * 60_000 });
  } else if (status === 'ELIGIBILITY_FAILED') {
    events.push({ eventType: 'eligibility.failed', resultingStatus: 'ELIGIBILITY_FAILED', offsetMs: 30 * 60_000 });
  }
  if (post('PREAUTH_DRAFTING') && status !== 'ELIGIBILITY_FAILED') {
    events.push({ eventType: 'preauth.drafting', resultingStatus: 'PREAUTH_DRAFTING', offsetMs: 45 * 60_000 });
  }
  if (post('PREAUTH_SUBMITTED')) {
    events.push({ eventType: 'preauth.submitted', resultingStatus: 'PREAUTH_SUBMITTED', offsetMs: 60 * 60_000 });
  }
  if (post('PREAUTH_QUERY_RAISED') && status !== 'PREAUTH_APPROVED' && status !== 'PREAUTH_REJECTED') {
    events.push({ eventType: 'preauth.queried', resultingStatus: 'PREAUTH_QUERY_RAISED', offsetMs: 2 * 3600 * 1000 });
  }
  if (status === 'PREAUTH_QUERY_RESPONDED' || (post('PREAUTH_QUERY_RESPONDED') && status !== 'PREAUTH_REJECTED')) {
    if (events.some((e) => e.resultingStatus === 'PREAUTH_QUERY_RAISED')) {
      events.push({ eventType: 'preauth.query.responded', resultingStatus: 'PREAUTH_QUERY_RESPONDED', offsetMs: 4 * 3600 * 1000 });
    }
  }
  if (status === 'PREAUTH_APPROVED' || post('CLAIM_DRAFTING')) {
    events.push({ eventType: 'preauth.approved', resultingStatus: 'PREAUTH_APPROVED', offsetMs: 6 * 3600 * 1000 });
  } else if (status === 'PREAUTH_REJECTED') {
    events.push({ eventType: 'preauth.rejected', resultingStatus: 'PREAUTH_REJECTED', offsetMs: 6 * 3600 * 1000 });
  } else if (status === 'PREAUTH_PARTIALLY_APPROVED') {
    events.push({ eventType: 'preauth.partially_approved', resultingStatus: 'PREAUTH_PARTIALLY_APPROVED', offsetMs: 6 * 3600 * 1000 });
  } else if (status === 'PREAUTH_CANCELLED') {
    events.push({ eventType: 'preauth.cancelled', resultingStatus: 'PREAUTH_CANCELLED', offsetMs: 6 * 3600 * 1000 });
  }
  if (post('DISCHARGE_SUBMITTED')) {
    events.push({ eventType: 'discharge.submitted', resultingStatus: 'DISCHARGE_SUBMITTED', offsetMs: 24 * 3600 * 1000 });
  }
  if (post('CLAIM_SUBMITTED')) {
    events.push({ eventType: 'claim.submitted', resultingStatus: 'CLAIM_SUBMITTED', offsetMs: 26 * 3600 * 1000 });
  }
  if (status === 'CLAIM_APPROVED' || post('PAYMENT_PENDING')) {
    events.push({ eventType: 'claim.approved', resultingStatus: 'CLAIM_APPROVED', offsetMs: 30 * 3600 * 1000 });
  } else if (status === 'CLAIM_REJECTED' || status === 'APPEAL_INITIATED' || status === 'APPEAL_SUBMITTED' || status === 'CLAIM_REPROCESS_REQUESTED') {
    events.push({ eventType: 'claim.rejected', resultingStatus: 'CLAIM_REJECTED', offsetMs: 30 * 3600 * 1000 });
  } else if (status === 'CLAIM_PARTIALLY_APPROVED' || status === 'SHORT_PAID') {
    events.push({ eventType: 'claim.partially_approved', resultingStatus: 'CLAIM_PARTIALLY_APPROVED', offsetMs: 30 * 3600 * 1000 });
  }
  if (status === 'PAYMENT_RECEIVED' || status === 'PAYMENT_RECONCILED') {
    events.push({ eventType: 'payment.received', resultingStatus: 'PAYMENT_RECEIVED', offsetMs: 35 * 3600 * 1000 });
  }
  if (status === 'PAYMENT_RECONCILED') {
    events.push({ eventType: 'payment.reconciled', resultingStatus: 'PAYMENT_RECONCILED', offsetMs: 40 * 3600 * 1000 });
  }
  if (status === 'SHORT_PAID') {
    events.push({ eventType: 'payment.short', resultingStatus: 'SHORT_PAID', offsetMs: 35 * 3600 * 1000 });
  }
  if (status === 'WRITTEN_OFF') {
    events.push({ eventType: 'claim.written_off', resultingStatus: 'WRITTEN_OFF', offsetMs: 40 * 3600 * 1000 });
  }
  if (status === 'APPEAL_INITIATED' || status === 'APPEAL_SUBMITTED') {
    events.push({ eventType: 'appeal.initiated', resultingStatus: 'APPEAL_INITIATED', offsetMs: 36 * 3600 * 1000 });
  }
  if (status === 'APPEAL_SUBMITTED') {
    events.push({ eventType: 'appeal.submitted', resultingStatus: 'APPEAL_SUBMITTED', offsetMs: 38 * 3600 * 1000 });
  }
  if (status === 'CLAIM_REPROCESS_REQUESTED') {
    events.push({ eventType: 'claim.reprocess.requested', resultingStatus: 'CLAIM_REPROCESS_REQUESTED', offsetMs: 35 * 3600 * 1000 });
  }
  if (status === 'ABANDONED') {
    events.push({ eventType: 'case.abandoned', resultingStatus: 'ABANDONED', offsetMs: 48 * 3600 * 1000 });
  }

  // Write each event in chain order.
  let prevId: string | null = null;
  const correlationId = `corr-${claimId.slice(0, 8)}`;
  for (const e of events) {
    const created = await tx.claimEvent.create({
      data: {
        tenantId,
        claimId,
        eventType: e.eventType,
        resultingStatus: e.resultingStatus,
        occurredAt: new Date(admissionAt.getTime() + e.offsetMs),
        recordedById: actorUserId,
        payload: e.payload ?? {},
        correlationId,
        prevEventId: prevId,
      },
      select: { id: true },
    });
    prevId = created.id;
  }
  return correlationId;
}

// Ordering for status progression. Used by `post(s)` to decide
// whether a given final status should include earlier events.
const CLAIM_PROGRESSION: Record<ClaimStatus, number> = {
  INITIATED: 0,
  ELIGIBILITY_CHECK_PENDING: 1,
  ELIGIBILITY_VERIFIED: 2,
  ELIGIBILITY_FAILED: 2,
  PREAUTH_DRAFTING: 3,
  PREAUTH_QUEUED: 4,
  PREAUTH_SUBMITTED: 5,
  PREAUTH_QUERY_RAISED: 6,
  PREAUTH_QUERY_RESPONDED: 7,
  PREAUTH_APPROVED: 8,
  PREAUTH_REJECTED: 8,
  PREAUTH_PARTIALLY_APPROVED: 8,
  PREAUTH_CANCELLED: 8,
  ENHANCEMENT_DRAFTING: 9,
  ENHANCEMENT_QUEUED: 10,
  ENHANCEMENT_SUBMITTED: 11,
  ENHANCEMENT_APPROVED: 12,
  ENHANCEMENT_REJECTED: 12,
  DISCHARGE_PENDING: 13,
  DISCHARGE_SUBMITTED: 14,
  CLAIM_DRAFTING: 15,
  CLAIM_QUEUED: 16,
  CLAIM_SUBMITTED: 17,
  CLAIM_QUERY_RAISED: 18,
  CLAIM_QUERY_RESPONDED: 19,
  CLAIM_APPROVED: 20,
  CLAIM_REJECTED: 20,
  CLAIM_PARTIALLY_APPROVED: 20,
  CLAIM_REPROCESS_REQUESTED: 21,
  PAYMENT_PENDING: 22,
  PAYMENT_RECEIVED: 23,
  PAYMENT_RECONCILED: 24,
  SHORT_PAID: 24,
  WRITTEN_OFF: 25,
  APPEAL_INITIATED: 26,
  APPEAL_SUBMITTED: 27,
  ABANDONED: 28,
};

async function generateCase(tx: Prisma.TransactionClient, ctx: CaseGenContext, mrnCounter: number): Promise<void> {
  const { tenantId, tenantSlug, patient, actorUserId, rail, template } = ctx;
  const procedure = rand(PROCEDURES);
  const diagnosis = rand(DIAGNOSIS_CODES);
  const payer = pickPayer(rail);
  const daysOld = randInt(template.daysAgoMin, template.daysAgoMax);
  const admissionAt = daysAgo(daysOld);

  // Amounts scale with procedure base. Variance ±15%.
  const variance = 0.85 + Math.random() * 0.30;
  const preauthAmount = Math.round(procedure.basePaise * variance);
  const claimAmount = Math.round(preauthAmount * (0.95 + Math.random() * 0.10));
  // Approved / paid amounts depend on final status.
  let approvedAmount: number | null = null;
  let paidAmount: number | null = null;
  if (
    template.status === 'CLAIM_APPROVED' ||
    template.status === 'PAYMENT_PENDING' ||
    template.status === 'PAYMENT_RECEIVED' ||
    template.status === 'PAYMENT_RECONCILED'
  ) {
    approvedAmount = claimAmount;
  }
  if (template.status === 'CLAIM_PARTIALLY_APPROVED' || template.status === 'SHORT_PAID') {
    approvedAmount = Math.round(claimAmount * (0.55 + Math.random() * 0.25));
  }
  if (template.status === 'PAYMENT_RECEIVED' || template.status === 'PAYMENT_RECONCILED') {
    paidAmount = approvedAmount;
  }
  if (template.status === 'SHORT_PAID') {
    paidAmount = Math.round((approvedAmount ?? claimAmount) * 0.85);
  }

  // Case status (closed for finalised, open otherwise).
  const closedStatuses: ClaimStatus[] = [
    'PAYMENT_RECONCILED', 'WRITTEN_OFF', 'PREAUTH_REJECTED',
    'CLAIM_REJECTED', 'ABANDONED',
  ];
  const caseStatus = closedStatuses.includes(template.status)
    ? template.status === 'ABANDONED' ? 'abandoned' : 'closed'
    : 'open';

  const caseRow = await tx.case.create({
    data: {
      tenantId,
      patientId: patient.id,
      patientName: patient.fullName,
      hospitalMrn: mrnFor(tenantSlug, mrnCounter),
      admissionDate: admissionAt,
      admissionType: rand(['planned', 'emergency', 'day_care'] as const),
      primaryRail: rail,
      caseStatus,
      createdById: actorUserId,
      roomDailyRate: randInt(3000, 8000) * 100, // paise
      policyRoomRentLimit: 5000 * 100,
      estimatedStayDays: randInt(2, 8),
      ...(caseStatus !== 'open' ? { closedAt: daysAgo(Math.max(0, daysOld - 3)) } : {}),
    },
    select: { id: true },
  });

  const claim = await tx.claim.create({
    data: {
      tenantId,
      caseId: caseRow.id,
      rail,
      status: template.status,
      preauthAmount: CLAIM_PROGRESSION[template.status] >= CLAIM_PROGRESSION.PREAUTH_SUBMITTED ? preauthAmount : null,
      claimAmount: CLAIM_PROGRESSION[template.status] >= CLAIM_PROGRESSION.CLAIM_SUBMITTED ? claimAmount : null,
      approvedAmount,
      paidAmount,
      preauthRefNum: CLAIM_PROGRESSION[template.status] >= CLAIM_PROGRESSION.PREAUTH_SUBMITTED ? `PA-${caseRow.id.slice(0, 8).toUpperCase()}` : null,
      claimRefNum: CLAIM_PROGRESSION[template.status] >= CLAIM_PROGRESSION.CLAIM_SUBMITTED ? `CL-${caseRow.id.slice(0, 8).toUpperCase()}` : null,
      payerCode: payer.code,
      assignedToUserId: actorUserId,
      submittedAt: CLAIM_PROGRESSION[template.status] >= CLAIM_PROGRESSION.PREAUTH_SUBMITTED ? new Date(admissionAt.getTime() + 60 * 60_000) : null,
      approvedAt: approvedAmount !== null ? new Date(admissionAt.getTime() + 6 * 3600 * 1000) : null,
      paidAt: paidAmount !== null ? new Date(admissionAt.getTime() + 35 * 3600 * 1000) : null,
    },
    select: { id: true },
  });

  const correlationId = await writeEventTrail(
    tx,
    tenantId,
    claim.id,
    template.status,
    admissionAt,
    actorUserId,
  );

  // Integration messages — one outbound per submission, one inbound
  // per response. Stamped 'succeeded' for closed states; 'pending'
  // for in-flight.
  if (CLAIM_PROGRESSION[template.status] >= CLAIM_PROGRESSION.ELIGIBILITY_CHECK_PENDING && rail !== 'self_pay') {
    await tx.integrationMessage.create({
      data: {
        tenantId,
        claimId: claim.id,
        direction: 'outbound',
        integration: rail === 'pmjay' ? 'pmjay_tms' : 'nhcx',
        operation: 'eligibility.verify',
        correlationId,
        status: template.status === 'ELIGIBILITY_FAILED' ? 'failed' : 'succeeded',
        failureClass: template.status === 'ELIGIBILITY_FAILED' ? 'validation' : null,
        rawRequest: { procedure: procedure.code, diagnosis: diagnosis.code, payer: payer.code },
        rawResponse: { verified: template.status !== 'ELIGIBILITY_FAILED' },
        completedAt: new Date(admissionAt.getTime() + 25 * 60_000),
      },
    });
  }
  if (CLAIM_PROGRESSION[template.status] >= CLAIM_PROGRESSION.PREAUTH_SUBMITTED && rail !== 'self_pay') {
    await tx.integrationMessage.create({
      data: {
        tenantId,
        claimId: claim.id,
        direction: 'outbound',
        integration: rail === 'pmjay' ? 'pmjay_tms' : 'nhcx',
        operation: 'preauth.submit',
        correlationId,
        status: 'succeeded',
        rawRequest: { preauthAmount, procedure: procedure.code },
        rawResponse: { acknowledged: true, payerRefNum: `PA-${claim.id.slice(0, 8)}` },
        completedAt: new Date(admissionAt.getTime() + 65 * 60_000),
      },
    });
  }
  if (CLAIM_PROGRESSION[template.status] >= CLAIM_PROGRESSION.CLAIM_SUBMITTED && rail !== 'self_pay') {
    await tx.integrationMessage.create({
      data: {
        tenantId,
        claimId: claim.id,
        direction: 'outbound',
        integration: rail === 'pmjay' ? 'pmjay_tms' : 'nhcx',
        operation: 'claim.submit',
        correlationId,
        status: 'succeeded',
        rawRequest: { claimAmount },
        rawResponse: { acknowledged: true, claimRefNum: `CL-${claim.id.slice(0, 8)}` },
        completedAt: new Date(admissionAt.getTime() + 27 * 3600 * 1000),
      },
    });
  }

  // Preauth query rows for the query states.
  if (template.status === 'PREAUTH_QUERY_RAISED' || template.status === 'PREAUTH_QUERY_RESPONDED') {
    await tx.preauthQuery.create({
      data: {
        tenantId,
        claimId: claim.id,
        queryText: 'Please share latest diagnostic report supporting medical necessity.',
        raisedAt: new Date(admissionAt.getTime() + 2 * 3600 * 1000),
        respondedAt:
          template.status === 'PREAUTH_QUERY_RESPONDED'
            ? new Date(admissionAt.getTime() + 4 * 3600 * 1000)
            : null,
        responseText:
          template.status === 'PREAUTH_QUERY_RESPONDED'
            ? 'Attached MRI report dated last week confirming the diagnosis.'
            : null,
        correlationId,
      },
    });
  }

  // Settlement rows for the payment / variance states.
  if (
    template.status === 'PAYMENT_PENDING' ||
    template.status === 'PAYMENT_RECEIVED' ||
    template.status === 'PAYMENT_RECONCILED' ||
    template.status === 'SHORT_PAID' ||
    template.status === 'WRITTEN_OFF'
  ) {
    const expected = approvedAmount ?? claimAmount;
    const received = paidAmount ?? (template.status === 'PAYMENT_PENDING' ? null : 0);
    const deductionAmt = received !== null ? Math.max(0, expected - received) : 0;
    await tx.settlement.create({
      data: {
        tenantId,
        claimId: claim.id,
        paymentMode: 'NEFT',
        expectedAmount: expected,
        receivedAmount: received,
        deductionAmount: deductionAmt,
        deductions:
          template.status === 'SHORT_PAID'
            ? [
                { reasonCode: 'NM-CONS', label: 'Non-medical consumables', amountPaise: deductionAmt },
              ]
            : [],
        shortPaymentReasons:
          template.status === 'SHORT_PAID' ? ['non_medical_strip', 'package_capped'] : [],
        receivedAt:
          template.status === 'PAYMENT_RECEIVED' || template.status === 'PAYMENT_RECONCILED' || template.status === 'SHORT_PAID'
            ? new Date(admissionAt.getTime() + 35 * 3600 * 1000)
            : null,
        reconciliationStatus:
          template.status === 'PAYMENT_RECONCILED'
            ? 'reconciled'
            : template.status === 'WRITTEN_OFF'
              ? 'written_off'
              : 'manual_match_pending',
        closedAt:
          template.status === 'PAYMENT_RECONCILED' || template.status === 'WRITTEN_OFF'
            ? new Date(admissionAt.getTime() + 40 * 3600 * 1000)
            : null,
      },
    });
  }

  // Appeal rows for appeal states.
  if (template.status === 'APPEAL_INITIATED' || template.status === 'APPEAL_SUBMITTED') {
    await tx.appeal.create({
      data: {
        tenantId,
        claimId: claim.id,
        reason: 'Clinical justification submitted; rejection appears to misread the policy exclusion.',
        status: template.status === 'APPEAL_SUBMITTED' ? 'submitted' : 'initiated',
        startedAt: new Date(admissionAt.getTime() + 36 * 3600 * 1000),
        startedByUserId: actorUserId,
        submittedAt:
          template.status === 'APPEAL_SUBMITTED'
            ? new Date(admissionAt.getTime() + 38 * 3600 * 1000)
            : null,
      },
    });
  }
}

// ---------- Public entry point ----------

export async function seedCasesForTenant(
  tx: Prisma.TransactionClient,
  input: SeedCasesInput,
): Promise<void> {
  const { tenantId, tenantSlug, caseCount, rails, actorUserIds } = input;

  // Generate enough patients so most have 1 case (a few repeat).
  const patientCount = Math.max(20, Math.round(caseCount * 0.85));
  const patients = await ensurePatients(tx, tenantId, patientCount);

  const distribution = scaleDistribution(FULL_DISTRIBUTION, caseCount, rails);

  let mrnCounter = 1;
  for (const template of distribution) {
    for (let i = 0; i < template.count; i += 1) {
      const eligibleRails = (template.rails ?? rails).filter((r) => rails.includes(r));
      const rail = rand(eligibleRails.length > 0 ? eligibleRails : rails);
      const patient = rand(patients);
      const actorUserId = rand(actorUserIds);
      await generateCase(
        tx,
        { tenantId, tenantSlug, patient, actorUserId, rail, template },
        mrnCounter,
      );
      mrnCounter += 1;
    }
  }
}
