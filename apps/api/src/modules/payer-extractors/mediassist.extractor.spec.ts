import { MediassistExtractor } from './mediassist.extractor';
import { type ExtractedEob } from '../eob-ocr/eob-ocr-adapter.interface';

describe('MediassistExtractor', () => {
  const ext = new MediassistExtractor();

  const baseEob = (overrides: Partial<ExtractedEob> = {}): ExtractedEob => ({
    deductions: [],
    shortPaymentReasons: [],
    ...overrides,
  });

  describe('detect', () => {
    it('matches MA- claim-ref prefix', () => {
      expect(ext.detect(baseEob({ claimRefNum: 'MA-2026-7788' }))).toBe(true);
    });

    it('matches MAS/ claim-ref prefix', () => {
      expect(ext.detect(baseEob({ claimRefNum: 'MAS/CL/123' }))).toBe(true);
    });

    it('matches MEDI claim-ref prefix', () => {
      expect(ext.detect(baseEob({ claimRefNum: 'MEDI-99-2026' }))).toBe(true);
    });

    it('matches "Medi Assist" with space', () => {
      expect(
        ext.detect(baseEob({ shortPaymentReasons: ['Per Medi Assist adjudication note'] })),
      ).toBe(true);
    });

    it('matches "Medi-Assist" with hyphen', () => {
      expect(
        ext.detect(baseEob({ shortPaymentReasons: ['Mediassist TPA review'] })),
      ).toBe(true);
    });
  });

  describe('normalise', () => {
    it('maps consumables/disposables → non_payable_items (Mediassist signature phrasing)', () => {
      const out = ext.normalise(
        baseEob({
          deductions: [
            { category: 'Consumables and disposables', amount: 250 },
            { category: 'Consumables & disposables', amount: 100 },
          ],
        }),
      );
      expect(out.deductions[0]!.category).toBe('non_payable_items');
      expect(out.deductions[1]!.category).toBe('non_payable_items');
    });

    it('maps proportionate deduction → sublimit', () => {
      const out = ext.normalise(
        baseEob({
          deductions: [{ category: 'Proportionate deduction', amount: 800 }],
        }),
      );
      expect(out.deductions[0]!.category).toBe('sublimit');
    });

    it('maps "not covered" → exclusion', () => {
      const out = ext.normalise(
        baseEob({
          deductions: [{ category: 'Item not covered under policy', amount: 150 }],
        }),
      );
      expect(out.deductions[0]!.category).toBe('exclusion');
    });
  });
});
