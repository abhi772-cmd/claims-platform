import { HdfcErgoExtractor } from './hdfc-ergo.extractor';
import { type ExtractedEob } from '../eob-ocr/eob-ocr-adapter.interface';

describe('HdfcErgoExtractor', () => {
  const ext = new HdfcErgoExtractor();

  const baseEob = (overrides: Partial<ExtractedEob> = {}): ExtractedEob => ({
    deductions: [],
    shortPaymentReasons: [],
    ...overrides,
  });

  describe('detect', () => {
    it('matches HE/ claim-ref prefix', () => {
      expect(ext.detect(baseEob({ claimRefNum: 'HE/2026/0042' }))).toBe(true);
    });

    it('matches HDFC/ claim-ref prefix', () => {
      expect(ext.detect(baseEob({ claimRefNum: 'HDFC/CL/123' }))).toBe(true);
    });

    it('matches HEHI claim-ref prefix', () => {
      expect(ext.detect(baseEob({ claimRefNum: 'HEHI-987' }))).toBe(true);
    });

    it('matches "HDFC Ergo" in reason copy', () => {
      expect(
        ext.detect(baseEob({ shortPaymentReasons: ['Per HDFC Ergo guidelines'] })),
      ).toBe(true);
    });

    it('rejects HDFC ref without /Ergo (could be HDFC Bank or other entity)', () => {
      expect(ext.detect(baseEob({ claimRefNum: 'OTHER-HDFC-99' }))).toBe(false);
    });
  });

  describe('normalise', () => {
    it('maps HDFC-specific phrasing including R&C exclusion + deductible', () => {
      const out = ext.normalise(
        baseEob({
          deductions: [
            { category: 'Cap exceeded', amount: 500 },
            { category: 'Deductible', amount: 1000, reason: 'Annual deductible' },
            { category: 'Sub-limit', amount: 300 },
            { category: 'Pre-existing', amount: 800 },
            { category: 'Reasonable & Customary', amount: 1500, reason: 'Aesthetic procedure' },
            { category: 'Non-payable', amount: 50 },
            { category: 'Missing documents', amount: 100 },
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

    it('reads "Reasonable and Customary" with the word "and" (not just &)', () => {
      const out = ext.normalise(
        baseEob({
          deductions: [{ category: 'Reasonable and Customary deduction', amount: 200 }],
        }),
      );
      expect(out.deductions[0]!.category).toBe('exclusion');
    });
  });
});
