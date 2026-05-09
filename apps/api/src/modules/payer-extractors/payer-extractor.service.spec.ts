
import { BajajAllianzExtractor } from './bajaj-allianz.extractor';
import { PayerExtractorService } from './payer-extractor.service';
import { StarHealthExtractor } from './star-health.extractor';
import { type ExtractedEob } from '../eob-ocr/eob-ocr-adapter.interface';

describe('PayerExtractorService.detectAndNormalise', () => {
  const star = new StarHealthExtractor();
  const bajaj = new BajajAllianzExtractor();
  const service = new PayerExtractorService([star, bajaj]);

  const baseEob = (overrides: Partial<ExtractedEob> = {}): ExtractedEob => ({
    deductions: [],
    shortPaymentReasons: [],
    ...overrides,
  });

  it('routes Star claim refs to the Star extractor', () => {
    const out = service.detectAndNormalise(
      baseEob({
        claimRefNum: 'STAR/2026/0042',
        deductions: [{ category: 'Co-pay', amount: 500 }],
      }),
    );
    expect(out.payerCode).toBe('star_health');
    expect(out.eob.deductions[0]!.category).toBe('copay');
  });

  it('routes Bajaj claim refs to the Bajaj extractor', () => {
    const out = service.detectAndNormalise(
      baseEob({
        claimRefNum: 'BAGI-2026-0987',
        deductions: [{ category: 'Excluded items', amount: 800 }],
      }),
    );
    expect(out.payerCode).toBe('bajaj_allianz');
    expect(out.eob.deductions[0]!.category).toBe('exclusion');
  });

  it('falls back to generic when no extractor matches', () => {
    const eob = baseEob({
      claimRefNum: 'UNKNOWN-PAYER-X',
      deductions: [{ category: 'mystery', amount: 100 }],
    });
    const out = service.detectAndNormalise(eob);
    expect(out.payerCode).toBe('generic');
    // Generic path: eob comes back unchanged.
    expect(out.eob.deductions[0]!.category).toBe('mystery');
  });

  it('first matching extractor wins (registry order)', () => {
    // Pathological eob that matches both via reason copy:
    // claimRefNum is BAGI but a deduction reason mentions Star Health.
    // Bajaj extractor is listed second; Star extractor sees the reason
    // first because we registered Star ahead of Bajaj.
    const eob = baseEob({
      claimRefNum: 'BAGI-9999',
      shortPaymentReasons: ['Per Star Health rider B'],
    });
    // Order in this test mirrors the production module: Star, Bajaj.
    const out = service.detectAndNormalise(eob);
    // Star wins because it's first AND its reason regex matches first.
    expect(out.payerCode).toBe('star_health');
  });
});
