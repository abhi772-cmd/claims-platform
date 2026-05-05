// Master-data seed (Slice O). Idempotent — re-running after a row change
// updates the row in place rather than creating duplicates. Keep this
// list small + representative; production master sync will replace it.
//
// Run via: pnpm --filter @claims/api db:seed:master

import { Prisma, PrismaClient } from '@prisma/client';

interface PayerSeed {
  code: string;
  name: string;
  payerType: 'private_tpa' | 'private_insurer' | 'pmjay_sha' | 'cghs' | 'self';
  rail: 'nhcx' | 'pmjay' | 'self_pay';
  hcxCode?: string;
}

const PAYERS: PayerSeed[] = [
  // Private TPAs — the four largest in India by claim volume.
  { code: 'MEDIASSIST', name: 'Medi Assist Healthcare', payerType: 'private_tpa', rail: 'nhcx', hcxCode: 'MAHIPL' },
  { code: 'PARAMOUNT', name: 'Paramount Health Services', payerType: 'private_tpa', rail: 'nhcx', hcxCode: 'PHS' },
  { code: 'FHPL', name: 'Family Health Plan', payerType: 'private_tpa', rail: 'nhcx', hcxCode: 'FHPL' },
  { code: 'HEALTHINDIA', name: 'Health India TPA', payerType: 'private_tpa', rail: 'nhcx', hcxCode: 'HITPA' },
  // Private insurers (direct).
  { code: 'STAR_HEALTH', name: 'Star Health and Allied Insurance', payerType: 'private_insurer', rail: 'nhcx', hcxCode: 'STAR' },
  { code: 'HDFC_ERGO', name: 'HDFC ERGO General Insurance', payerType: 'private_insurer', rail: 'nhcx', hcxCode: 'HDFC' },
  { code: 'NIVA_BUPA', name: 'Niva Bupa Health Insurance', payerType: 'private_insurer', rail: 'nhcx', hcxCode: 'NIVA' },
  // PMJAY — one row per state SHA. Only one shipped here for the seed.
  { code: 'SHA_PMJAY_KA', name: 'State Health Agency — Karnataka (PMJAY)', payerType: 'pmjay_sha', rail: 'pmjay' },
  // CGHS / self.
  { code: 'CGHS', name: 'Central Government Health Scheme', payerType: 'cghs', rail: 'nhcx' },
  { code: 'SELF_PAY', name: 'Self Pay (Patient Out-of-Pocket)', payerType: 'self', rail: 'self_pay' },
];

interface PackageSeed {
  code: string;
  name: string;
  category: string;
  amount: number; // paise
  pmjayHbp?: boolean;
}

// PMJAY HBP samples (national list is ~1,949 packages; ship a slice for dev).
// Amounts are illustrative and rounded to representative HBP values.
const PACKAGES: PackageSeed[] = [
  { code: 'HBP-CARDIO-001', name: 'CABG (Coronary Artery Bypass Grafting)', category: 'Cardiology', amount: 9000000, pmjayHbp: true },
  { code: 'HBP-CARDIO-002', name: 'PTCA Single Vessel + Stent', category: 'Cardiology', amount: 6000000, pmjayHbp: true },
  { code: 'HBP-ORTHO-001', name: 'Total Knee Replacement (Unilateral)', category: 'Orthopedics', amount: 8000000, pmjayHbp: true },
  { code: 'HBP-ORTHO-002', name: 'Total Hip Replacement', category: 'Orthopedics', amount: 9000000, pmjayHbp: true },
  { code: 'HBP-ORTHO-003', name: 'Spinal Fusion (single level)', category: 'Orthopedics', amount: 7500000, pmjayHbp: true },
  { code: 'HBP-ONCO-001', name: 'Chemotherapy — Day Care (per cycle)', category: 'Oncology', amount: 1500000, pmjayHbp: true },
  { code: 'HBP-ONCO-002', name: 'Radiotherapy — IMRT', category: 'Oncology', amount: 8500000, pmjayHbp: true },
  { code: 'HBP-NEPH-001', name: 'Hemodialysis (per session)', category: 'Nephrology', amount: 150000, pmjayHbp: true },
  { code: 'HBP-OBGY-001', name: 'Caesarean Delivery', category: 'Obstetrics', amount: 1500000, pmjayHbp: true },
  { code: 'HBP-OBGY-002', name: 'Normal Delivery', category: 'Obstetrics', amount: 600000, pmjayHbp: true },
  { code: 'HBP-PEDS-001', name: 'Neonatal ICU (per day)', category: 'Pediatrics', amount: 250000, pmjayHbp: true },
  { code: 'HBP-NEURO-001', name: 'Stroke — Acute Care + Thrombolysis', category: 'Neurology', amount: 4500000, pmjayHbp: true },
  // Private rail tariff samples.
  { code: 'PRIV-APPENDECTOMY', name: 'Laparoscopic Appendectomy', category: 'General Surgery', amount: 3500000, pmjayHbp: false },
  { code: 'PRIV-CHOLECYSTECTOMY', name: 'Laparoscopic Cholecystectomy', category: 'General Surgery', amount: 5000000, pmjayHbp: false },
];

interface IcdSeed {
  code: string;
  description: string;
  chapter: string;
}

// ICD-10-CM samples — one per chapter that's claim-relevant for India.
const ICD_CODES: IcdSeed[] = [
  { code: 'A09', description: 'Infectious gastroenteritis and colitis, unspecified', chapter: 'I' },
  { code: 'B34.9', description: 'Viral infection, unspecified', chapter: 'I' },
  { code: 'C50.9', description: 'Malignant neoplasm of breast, unspecified', chapter: 'II' },
  { code: 'C61', description: 'Malignant neoplasm of prostate', chapter: 'II' },
  { code: 'D64.9', description: 'Anaemia, unspecified', chapter: 'III' },
  { code: 'E11.9', description: 'Type 2 diabetes mellitus without complications', chapter: 'IV' },
  { code: 'E78.5', description: 'Hyperlipidaemia, unspecified', chapter: 'IV' },
  { code: 'F32.9', description: 'Major depressive disorder, single episode, unspecified', chapter: 'V' },
  { code: 'G40.9', description: 'Epilepsy, unspecified', chapter: 'VI' },
  { code: 'H25.9', description: 'Senile cataract, unspecified', chapter: 'VII' },
  { code: 'I10', description: 'Essential (primary) hypertension', chapter: 'IX' },
  { code: 'I21.9', description: 'Acute myocardial infarction, unspecified', chapter: 'IX' },
  { code: 'I63.9', description: 'Cerebral infarction, unspecified', chapter: 'IX' },
  { code: 'J18.9', description: 'Pneumonia, unspecified organism', chapter: 'X' },
  { code: 'J44.9', description: 'Chronic obstructive pulmonary disease, unspecified', chapter: 'X' },
  { code: 'K35.80', description: 'Acute appendicitis, unspecified', chapter: 'XI' },
  { code: 'K80.20', description: 'Calculus of gallbladder without cholecystitis', chapter: 'XI' },
  { code: 'N18.6', description: 'End stage renal disease', chapter: 'XIV' },
  { code: 'O82', description: 'Encounter for caesarean delivery without indication', chapter: 'XV' },
  { code: 'P07.30', description: 'Preterm newborn, unspecified weeks of gestation', chapter: 'XVI' },
  { code: 'S72.001A', description: 'Fracture of unspecified part of neck of right femur', chapter: 'XIX' },
];

interface BillingSeed {
  code: string;
  description: string;
  category: string;
  baseAmount?: number;
}

// Billing codes — illustrative subset of common procedures + bed types.
const BILLING_CODES: BillingSeed[] = [
  { code: 'ROOM-GEN', description: 'General Ward (per day)', category: 'Room', baseAmount: 200000 },
  { code: 'ROOM-SEMI', description: 'Semi-Private Room (per day)', category: 'Room', baseAmount: 350000 },
  { code: 'ROOM-PVT', description: 'Private Room (per day)', category: 'Room', baseAmount: 600000 },
  { code: 'ROOM-DELUXE', description: 'Deluxe Room (per day)', category: 'Room', baseAmount: 900000 },
  { code: 'ICU-GEN', description: 'ICU (per day)', category: 'Room', baseAmount: 1500000 },
  { code: 'ICU-NICU', description: 'NICU (per day)', category: 'Room', baseAmount: 2000000 },
  { code: 'OT-MAJOR', description: 'OT Charges — Major', category: 'Procedure', baseAmount: 2500000 },
  { code: 'OT-MINOR', description: 'OT Charges — Minor', category: 'Procedure', baseAmount: 800000 },
  { code: 'CONS-GEN', description: 'Consultation — General', category: 'Consultation', baseAmount: 50000 },
  { code: 'CONS-SPEC', description: 'Consultation — Specialist', category: 'Consultation', baseAmount: 100000 },
  { code: 'INV-LAB', description: 'Laboratory Investigation (basket)', category: 'Diagnostics' },
  { code: 'INV-IMAGING', description: 'Imaging — CT/MRI', category: 'Diagnostics' },
  { code: 'INV-CARDIAC', description: 'ECG / Echo / TMT', category: 'Diagnostics' },
  { code: 'PHARM', description: 'Pharmacy', category: 'Pharmacy' },
  { code: 'CONSUM', description: 'Consumables / Implants', category: 'Consumables' },
];

interface ChecklistSeed {
  phase: 'preauth' | 'discharge' | 'claim' | 'all';
  rail: 'nhcx' | 'pmjay' | 'self_pay';
  documentType:
    | 'discharge_summary'
    | 'investigation_report'
    | 'implant_sticker'
    | 'OT_notes'
    | 'preauth_form'
    | 'final_bill'
    | 'EOB'
    | 'other';
  required: boolean;
}

const CHECKLIST_RULES: ChecklistSeed[] = [
  // NHCX preauth
  { phase: 'preauth', rail: 'nhcx', documentType: 'preauth_form', required: true },
  { phase: 'preauth', rail: 'nhcx', documentType: 'investigation_report', required: true },
  // NHCX discharge / claim
  { phase: 'discharge', rail: 'nhcx', documentType: 'discharge_summary', required: true },
  { phase: 'discharge', rail: 'nhcx', documentType: 'final_bill', required: true },
  { phase: 'claim', rail: 'nhcx', documentType: 'discharge_summary', required: true },
  { phase: 'claim', rail: 'nhcx', documentType: 'final_bill', required: true },
  { phase: 'claim', rail: 'nhcx', documentType: 'investigation_report', required: true },
  { phase: 'claim', rail: 'nhcx', documentType: 'OT_notes', required: false },
  { phase: 'claim', rail: 'nhcx', documentType: 'implant_sticker', required: false },
  // PMJAY
  { phase: 'preauth', rail: 'pmjay', documentType: 'preauth_form', required: true },
  { phase: 'discharge', rail: 'pmjay', documentType: 'discharge_summary', required: true },
  { phase: 'claim', rail: 'pmjay', documentType: 'discharge_summary', required: true },
  { phase: 'claim', rail: 'pmjay', documentType: 'final_bill', required: true },
];

async function seed(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );

      for (const p of PAYERS) {
        await tx.payer.upsert({
          where: { code: p.code },
          update: {
            name: p.name,
            payerType: p.payerType,
            rail: p.rail,
            ...(p.hcxCode !== undefined ? { hcxCode: p.hcxCode } : {}),
          },
          create: {
            code: p.code,
            name: p.name,
            payerType: p.payerType,
            rail: p.rail,
            ...(p.hcxCode !== undefined ? { hcxCode: p.hcxCode } : {}),
          },
        });
      }

      for (const pkg of PACKAGES) {
        await tx.package.upsert({
          where: { code: pkg.code },
          update: {
            name: pkg.name,
            category: pkg.category,
            amount: pkg.amount,
            pmjayHbp: pkg.pmjayHbp ?? false,
          },
          create: {
            code: pkg.code,
            name: pkg.name,
            category: pkg.category,
            amount: pkg.amount,
            pmjayHbp: pkg.pmjayHbp ?? false,
          },
        });
      }

      for (const c of ICD_CODES) {
        await tx.icdCode.upsert({
          where: { code: c.code },
          update: { description: c.description, chapter: c.chapter },
          create: { code: c.code, description: c.description, chapter: c.chapter },
        });
      }

      for (const b of BILLING_CODES) {
        await tx.billingCode.upsert({
          where: { code: b.code },
          update: {
            description: b.description,
            category: b.category,
            ...(b.baseAmount !== undefined ? { baseAmount: b.baseAmount } : {}),
          },
          create: {
            code: b.code,
            description: b.description,
            category: b.category,
            ...(b.baseAmount !== undefined ? { baseAmount: b.baseAmount } : {}),
          },
        });
      }

      // Checklist rules don't have a natural unique key (phase + rail + type
      // can repeat with different scoping). Idempotency: delete the global
      // (no payer/package/admissionType narrowing) defaults first then
      // re-insert. Custom narrowed rules added by ops are preserved.
      await tx.documentChecklistRule.deleteMany({
        where: {
          payerCode: null,
          packageCode: null,
          admissionType: null,
        },
      });
      for (const r of CHECKLIST_RULES) {
        await tx.documentChecklistRule.create({
          data: {
            phase: r.phase,
            rail: r.rail,
            documentType: r.documentType,
            required: r.required,
          },
        });
      }
    });

    // eslint-disable-next-line no-console
    console.log(
      `Master data seeded: ${PAYERS.length} payers, ${PACKAGES.length} packages, ` +
        `${ICD_CODES.length} ICD codes, ${BILLING_CODES.length} billing codes, ` +
        `${CHECKLIST_RULES.length} checklist rules.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

void seed().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
