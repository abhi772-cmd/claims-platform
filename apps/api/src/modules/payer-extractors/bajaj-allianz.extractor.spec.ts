import { BajajAllianzExtractor } from './bajaj-allianz.extractor';
import { type ExtractedEob } from '../eob-ocr/eob-ocr-adapter.interface';


describe('BajajAllianzExtractor', () => {
  const ext = new BajajAllianzExtractor();

  const baseEob = (overrides: Partial<ExtractedEob> = {}): ExtractedEob => ({
    deductions: [],
    shortPaymentReasons: [],
    ...overrides,
  });

  describe('detect', () => {
    it('matches BAGI claim ref prefix', () => {
      expect(ext.detect(baseEob({ claimRefNum: 'BAGI-2026-1234' }))).toBe(true);
    });

    it('matches BAJAJ claim ref prefix', () => {
      expect(ext.detect(baseEob({ claimRefNum: 'BAJAJ/CL/2026/89' }))).toBe(true);
    });

    it('matches "Bajaj Allianz" in reason copy', () => {
      expect(
        ext.detect(
          baseEob({
            shortPaymentReasons: ['Per Bajaj Allianz preauth note'],
          }),
        ),
      ).toBe(true);
    });

    it('rejects unrelated payers', () => {
      expect(ext.detect(baseEob({ claimRefNum: 'STAR/2026/0001' }))).toBe(false);
      expect(
        ext.detect(
          baseEob({
            shortPaymentReasons: ['ICICI Lombard short-pay note'],
          }),
        ),
      ).toBe(false);
    });
  });

  describe('normalise', () => {
    it('maps Bajaj-specific copy to canonical categories', () => {
      const out = ext.normalise(
        baseEob({
          deductions: [
            { category: 'Capping', amount: 800 },
            { category: 'Co-payment', amount: 1200 },
            { category: 'Inner limit', amount: 300, reason: 'room rent' },
            { category: 'PED', amount: 600 },
            { category: 'Excluded items', amount: 250 },
            { category: 'Non-payable', amount: 100 },
            { category: 'Insufficient supporting documentation', amount: 200 },
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

    it('uses reason text when category itself does not match', () => {
      const out = ext.normalise(
        baseEob({
          deductions: [
            { category: 'misc', amount: 100, reason: 'Inner limit on diagnostics' },
          ],
        }),
      );
      expect(out.deductions[0]!.category).toBe('sublimit');
    });
  });
});
