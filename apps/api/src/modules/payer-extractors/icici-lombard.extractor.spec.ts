import { IciciLombardExtractor } from './icici-lombard.extractor';
import { type ExtractedEob } from '../eob-ocr/eob-ocr-adapter.interface';

describe('IciciLombardExtractor', () => {
  const ext = new IciciLombardExtractor();

  const baseEob = (overrides: Partial<ExtractedEob> = {}): ExtractedEob => ({
    deductions: [],
    shortPaymentReasons: [],
    ...overrides,
  });

  describe('detect', () => {
    it('matches ICL claim-ref prefix', () => {
      expect(ext.detect(baseEob({ claimRefNum: 'ICL/2026/77' }))).toBe(true);
    });

    it('matches ICICI/ claim-ref prefix', () => {
      expect(ext.detect(baseEob({ claimRefNum: 'ICICI/CL/9988' }))).toBe(true);
    });

    it('matches ILGI claim-ref prefix', () => {
      expect(ext.detect(baseEob({ claimRefNum: 'ILGI-2026-1' }))).toBe(true);
    });

    it('matches "ICICI Lombard" in reason copy', () => {
      expect(
        ext.detect(
          baseEob({ shortPaymentReasons: ['Per ICICI Lombard policy clause 4.2'] }),
        ),
      ).toBe(true);
    });

    it('rejects unrelated payers', () => {
      expect(ext.detect(baseEob({ claimRefNum: 'STAR/2026/0001' }))).toBe(false);
      expect(ext.detect(baseEob({ claimRefNum: 'BAGI-99' }))).toBe(false);
    });
  });

  describe('normalise', () => {
    it('maps ICICI-specific phrasing to canonical categories', () => {
      const out = ext.normalise(
        baseEob({
          deductions: [
            { category: 'Capping', amount: 600 },
            { category: 'Co-payment', amount: 1500 },
            { category: 'Sub-limit', amount: 200, reason: 'room rent sublimit' },
            { category: 'PED', amount: 800 },
            { category: 'First 24-hour exclusion', amount: 100 },
            { category: 'Non-payable items', amount: 150 },
            { category: 'Insufficient supporting documents', amount: 250 },
          ],
        }),
      );
      expect(out.deductions.map((d) => d.category)).toEqual([
        'cap_exceeded',
        'copay',
        'sublimit',
        'pre_existing',
        'exclusion',
        'non_payable_items',
        'missing_documents',
      ]);
    });

    it('treats room-rent capping as sublimit (more specific than cap_exceeded)', () => {
      const out = ext.normalise(
        baseEob({
          deductions: [{ category: 'Room-rent capping', amount: 1000 }],
        }),
      );
      expect(out.deductions[0]!.category).toBe('sublimit');
    });

    it('falls back to unknown when nothing matches', () => {
      const out = ext.normalise(
        baseEob({
          deductions: [{ category: 'mystery deduction', amount: 1 }],
        }),
      );
      expect(out.deductions[0]!.category).toBe('unknown');
    });
  });
});
