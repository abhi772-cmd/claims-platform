import { classifyBillLines } from './non-medical-classifier';

describe('classifyBillLines', () => {
  describe('classification rules', () => {
    it.each([
      ['Toiletry kit', 'toiletries'],
      ['Soap bar', 'toiletries'],
      ['Tooth paste', 'toiletries'],
      ['Sanitary napkins', 'toiletries'],
      ['Adult diaper', 'toiletries'],
      ['Attendant food', 'attendant_food'],
      ['Visitor meal charges', 'attendant_food'],
      ['Tea for attendant', 'attendant_food'],
      ['Attendant bed', 'attendant_stay'],
      ['Visitor pass', 'attendant_stay'],
      ['Registration fee', 'admin_fees'],
      ['Medical record copy', 'admin_fees'],
      ['File charge', 'admin_fees'],
      ['Service charge', 'admin_fees'],
      ['Birth certificate', 'documentation'],
      ['Duplicate report', 'documentation'],
      ['Medico-legal case charge', 'documentation'],
      ['Taxi fare', 'transport'],
      ['Vehicle parking', 'transport'],
      ['TV rental', 'comfort'],
      ['Telephone call charges', 'comfort'],
      ['Newspaper', 'comfort'],
      ['Wi-Fi charge', 'comfort'],
      ['Bed pan', 'miscellaneous_consumables'],
      ['Patient slipper', 'miscellaneous_consumables'],
      ['Non-medical items', 'miscellaneous'],
      ['Non payable consumables', 'miscellaneous'],
    ])('classifies "%s" as non-medical / %s', (description, expectedCategory) => {
      const out = classifyBillLines([{ description, amountPaise: 100 }]);
      expect(out.lines[0]!.medical).toBe(false);
      expect(out.lines[0]!.category).toBe(expectedCategory);
      expect(out.lines[0]!.matchedTerm).toBeTruthy();
    });

    it.each([
      'Room rent — single AC',
      'Doctor visit',
      'Operation theatre charges',
      'Anaesthesia',
      'IV fluids',
      'Surgery',
      'ECG',
      'Pathology — CBC',
      'Radiology — Chest X-ray',
      'Ventilator support per day',
      'Discharge summary', // bare; the duplicate-only rule should NOT fire here
      'Medical registration number — Dr. Sharma', // false-positive guard
    ])('leaves "%s" as medical (no rule fires)', (description) => {
      const out = classifyBillLines([{ description, amountPaise: 100 }]);
      expect(out.lines[0]!.medical).toBe(true);
      expect(out.lines[0]!.category).toBeNull();
      expect(out.lines[0]!.matchedTerm).toBeNull();
    });
  });

  describe('totals + by-category', () => {
    it('sums paise correctly across medical + non-medical', () => {
      const out = classifyBillLines([
        { description: 'Room rent — single AC', amountPaise: 800_000 },
        { description: 'Surgery', amountPaise: 5_000_000 },
        { description: 'Toiletry kit', amountPaise: 30_000 },
        { description: 'Attendant food', amountPaise: 80_000 },
        { description: 'TV rental', amountPaise: 20_000 },
      ]);
      expect(out.totals).toEqual({
        medicalPaise: 5_800_000,
        nonMedicalPaise: 130_000,
        grandTotalPaise: 5_930_000,
      });
    });

    it('aggregates by-category sorted by largest spend first', () => {
      const out = classifyBillLines([
        { description: 'Toiletry kit', amountPaise: 10_000 },
        { description: 'Soap bar', amountPaise: 5_000 },
        { description: 'Attendant food', amountPaise: 200_000 },
        { description: 'TV rental', amountPaise: 50_000 },
      ]);
      expect(out.byCategory).toEqual([
        { category: 'attendant_food', count: 1, amountPaise: 200_000 },
        { category: 'comfort', count: 1, amountPaise: 50_000 },
        { category: 'toiletries', count: 2, amountPaise: 15_000 },
      ]);
    });

    it('handles all-medical input — non-medical bucket stays empty', () => {
      const out = classifyBillLines([
        { description: 'Surgery', amountPaise: 5_000_000 },
        { description: 'Room rent', amountPaise: 800_000 },
      ]);
      expect(out.totals.nonMedicalPaise).toBe(0);
      expect(out.byCategory).toEqual([]);
    });

    it('handles all-non-medical input — medical bucket stays zero', () => {
      const out = classifyBillLines([
        { description: 'Toiletry kit', amountPaise: 30_000 },
        { description: 'TV rental', amountPaise: 50_000 },
      ]);
      expect(out.totals.medicalPaise).toBe(0);
      expect(out.totals.nonMedicalPaise).toBe(80_000);
    });
  });

  describe('matchedTerm transparency', () => {
    it('surfaces the exact substring that triggered the rule', () => {
      const out = classifyBillLines([
        { description: 'Patient TV rental — Saturday', amountPaise: 25_000 },
      ]);
      expect(out.lines[0]!.matchedTerm?.toLowerCase()).toContain('tv rental');
    });
  });
});
