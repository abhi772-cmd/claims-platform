import { StarHealthExtractor } from './star-health.extractor';
import { type ExtractedEob } from '../eob-ocr/eob-ocr-adapter.interface';


describe('StarHealthExtractor', () => {
  const ext = new StarHealthExtractor();

  const baseEob = (overrides: Partial<ExtractedEob> = {}): ExtractedEob => ({
    deductions: [],
    shortPaymentReasons: [],
    ...overrides,
  });

  describe('detect', () => {
    it('matches when claimRefNum starts with STAR/', () => {
      expect(ext.detect(baseEob({ claimRefNum: 'STAR/2026/00045' }))).toBe(true);
      expect(ext.detect(baseEob({ claimRefNum: 'star/2026/lower' }))).toBe(true);
    });

    it('matches when "Star Health" appears in reason copy', () => {
      expect(
        ext.detect(
          baseEob({
            shortPaymentReasons: ['As per Star Health internal policy', 'Co-pay 10%'],
          }),
        ),
      ).toBe(true);
    });

    it('matches via deduction reason text', () => {
      expect(
        ext.detect(
          baseEob({
            deductions: [
              { category: 'misc', amount: 500, reason: 'Per Star Health rider B' },
            ],
          }),
        ),
      ).toBe(true);
    });

    it('does not match when nothing identifies the payer', () => {
      expect(ext.detect(baseEob({ claimRefNum: 'BAGI/2026/00099' }))).toBe(false);
      expect(ext.detect(baseEob())).toBe(false);
    });
  });

  describe('normalise', () => {
    it('canonicalises Star deduction copy to the canonical taxonomy', () => {
      const eob = baseEob({
        deductions: [
          { category: 'Cap exceeded', amount: 1000, reason: 'rider B cap' },
          { category: 'Co-pay', amount: 500 },
          { category: 'Sub-limit', amount: 200, reason: 'room rent sublimit' },
          { category: 'Pre-existing', amount: 800 },
          { category: 'Exclusions', amount: 100 },
          { category: 'Non-payable items', amount: 50 },
          { category: 'Missing documents', amount: 150 },
        ],
      });
      const out = ext.normalise(eob);
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

    it('falls back to category=unknown when no rule matches', () => {
      const out = ext.normalise(
        baseEob({
          deductions: [{ category: 'mystery deduction', amount: 999 }],
        }),
      );
      expect(out.deductions[0]!.category).toBe('unknown');
    });

    it('preserves other eob fields verbatim', () => {
      const out = ext.normalise(
        baseEob({
          claimRefNum: 'STAR/2026/00045',
          receivedAmount: 12000,
          deductionAmount: 1500,
          deductions: [{ category: 'co-pay', amount: 1500 }],
          shortPaymentReasons: ['10% co-pay'],
        }),
      );
      expect(out.claimRefNum).toBe('STAR/2026/00045');
      expect(out.receivedAmount).toBe(12000);
      expect(out.deductionAmount).toBe(1500);
      expect(out.shortPaymentReasons).toEqual(['10% co-pay']);
    });
  });
});
