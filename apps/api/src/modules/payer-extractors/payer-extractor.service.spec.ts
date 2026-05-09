import { BajajAllianzExtractor } from './bajaj-allianz.extractor';
import { HdfcErgoExtractor } from './hdfc-ergo.extractor';
import { IciciLombardExtractor } from './icici-lombard.extractor';
import { MediassistExtractor } from './mediassist.extractor';
import { ParamountExtractor } from './paramount.extractor';
import { PayerExtractorService } from './payer-extractor.service';
import { StarHealthExtractor } from './star-health.extractor';
import { type ExtractedEob } from '../eob-ocr/eob-ocr-adapter.interface';

describe('PayerExtractorService.detectAndNormalise', () => {
  // Registry order mirrors PayerExtractorsModule's useFactory.
  const star = new StarHealthExtractor();
  const bajaj = new BajajAllianzExtractor();
  const icici = new IciciLombardExtractor();
  const hdfc = new HdfcErgoExtractor();
  const medi = new MediassistExtractor();
  const paramount = new ParamountExtractor();
  const service = new PayerExtractorService([star, bajaj, icici, hdfc, medi, paramount]);

  const baseEob = (overrides: Partial<ExtractedEob> = {}): ExtractedEob => ({
    deductions: [],
    shortPaymentReasons: [],
    ...overrides,
  });

  it.each([
    ['STAR/2026/0042', 'star_health', 'Co-pay', 'copay'],
    ['BAGI-2026-0987', 'bajaj_allianz', 'Excluded items', 'exclusion'],
    ['ICL/2026/77', 'icici_lombard', 'Co-payment', 'copay'],
    ['HE/2026/0042', 'hdfc_ergo', 'Reasonable & Customary', 'exclusion'],
    ['MA-2026-7788', 'mediassist', 'Consumables and disposables', 'non_payable_items'],
    ['PHS-2026-001', 'paramount', 'Co-share 10%', 'copay'],
  ])(
    'routes claimRefNum=%s to %s and normalises deduction',
    (claimRefNum, expectedPayer, deductionCategory, expectedCanonical) => {
      const out = service.detectAndNormalise(
        baseEob({
          claimRefNum,
          deductions: [{ category: deductionCategory, amount: 100 }],
        }),
      );
      expect(out.payerCode).toBe(expectedPayer);
      expect(out.eob.deductions[0]!.category).toBe(expectedCanonical);
    },
  );

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

  it('first matching extractor wins (registry order — Star ahead of Bajaj)', () => {
    // Pathological eob that matches Bajaj via claim-ref AND Star via
    // reason copy. Star wins because the registry lists it first.
    const eob = baseEob({
      claimRefNum: 'BAGI-9999',
      shortPaymentReasons: ['Per Star Health rider B'],
    });
    const out = service.detectAndNormalise(eob);
    expect(out.payerCode).toBe('star_health');
  });

  it('TPA name detection works alongside ref-prefix detection', () => {
    // Mediassist as a TPA may issue EOBs whose claim-ref carries the
    // underlying insurer's prefix instead. Our detection still
    // recognises Mediassist when its name shows up in reason copy.
    const eob = baseEob({
      claimRefNum: 'OTHER-CL-99',
      shortPaymentReasons: ['Adjudicated by Medi Assist on behalf of underwriter'],
    });
    const out = service.detectAndNormalise(eob);
    expect(out.payerCode).toBe('mediassist');
  });
});
