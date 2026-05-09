import { ParamountExtractor } from './paramount.extractor';
import { type ExtractedEob } from '../eob-ocr/eob-ocr-adapter.interface';

describe('ParamountExtractor', () => {
  const ext = new ParamountExtractor();

  const baseEob = (overrides: Partial<ExtractedEob> = {}): ExtractedEob => ({
    deductions: [],
    shortPaymentReasons: [],
    ...overrides,
  });

  describe('detect', () => {
    it.each([['PHS-2026-001'], ['PHI/CL/77'], ['PMT-99']])(
      'matches Paramount claim-ref prefix %s',
      (refNum) => {
        expect(ext.detect(baseEob({ claimRefNum: refNum }))).toBe(true);
      },
    );

    it('matches "Paramount Health" in reason copy', () => {
      expect(
        ext.detect(
          baseEob({
            shortPaymentReasons: ['Paramount Health Services adjudication note'],
          }),
        ),
      ).toBe(true);
    });

    it('rejects unrelated payers', () => {
      expect(ext.detect(baseEob({ claimRefNum: 'STAR/2026/0001' }))).toBe(false);
      expect(ext.detect(baseEob({ shortPaymentReasons: ['Star Health policy note'] }))).toBe(
        false,
      );
    });
  });

  describe('normalise', () => {
    it('maps "co-share" → copay (Paramount-specific phrasing)', () => {
      const out = ext.normalise(
        baseEob({
          deductions: [{ category: 'Co-share 10%', amount: 500 }],
        }),
      );
      expect(out.deductions[0]!.category).toBe('copay');
    });

    it('maps "investigation in progress" → missing_documents', () => {
      const out = ext.normalise(
        baseEob({
          deductions: [{ category: 'Investigation in progress', amount: 0, reason: 'Pending docs' }],
        }),
      );
      expect(out.deductions[0]!.category).toBe('missing_documents');
    });

    it('maps the standard taxonomy correctly', () => {
      const out = ext.normalise(
        baseEob({
          deductions: [
            { category: 'Cap exceeded', amount: 1000 },
            { category: 'Co-payment', amount: 500 },
            { category: 'Sub-limit', amount: 300 },
            { category: 'PED', amount: 800 },
            { category: 'Exclusions', amount: 200 },
            { category: 'Non-payable', amount: 100 },
            { category: 'Pending documents', amount: 150 },
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
  });
});
