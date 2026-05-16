// T2-13 — non-medical auto-strip classifier.
//
// Pure-function lookup that scans each bill line's description against
// a comprehensive Indian-hospital keyword catalog and classifies it as
// medical or non-medical. The catalog is *intentionally conservative*:
// when in doubt, leave the line as medical (the operator can still
// override). False negatives are recoverable (operator notices it on
// the bill); false positives ("you marked surgery as non-medical")
// would destroy trust in the tool.
//
// Catalog is built from the IRDAI list of common non-payable items
// + the cross-payer rules observed by the EOB extractors
// (apps/api/src/modules/payer-extractors/) — every line item that
// historically gets stripped on the EOB shows up here too.

import {
  type BillLine,
  type ClassifiedLine,
  type ClassifyNonMedicalResponse,
  type NonMedicalCategory,
} from '@claims/contracts';

interface KeywordRule {
  category: NonMedicalCategory;
  // Pre-compiled. Word-boundary anchored where possible so e.g.
  // "RegistrationFees" doesn't match against "MedicalRegistration"
  // (a doctor's registration number).
  rx: RegExp;
}

// Order matters only for the matchedTerm surfaced to the operator —
// the first rule that fires wins. Most specific phrases first.
const RULES: KeywordRule[] = [
  // Toiletries / personal care
  { category: 'toiletries', rx: /\btoile?tr(y|ies)\b/i },
  { category: 'toiletries', rx: /\bsoap\b/i },
  { category: 'toiletries', rx: /\bshampoo\b/i },
  { category: 'toiletries', rx: /\btooth[-\s]?paste\b/i },
  { category: 'toiletries', rx: /\btooth[-\s]?brush\b/i },
  { category: 'toiletries', rx: /\bcomb\b/i },
  { category: 'toiletries', rx: /\bsanitary\s*(napkin|pad)/i },
  { category: 'toiletries', rx: /\b(razor|shaving)\b/i },
  { category: 'toiletries', rx: /\b(diaper|adult\s*napkin)\b/i },
  { category: 'toiletries', rx: /\b(face|hand)\s*wash\b/i },
  { category: 'toiletries', rx: /\b(towel|hand\s*towel)\b/i },

  // Attendant food / meals
  { category: 'attendant_food', rx: /\battendant\s*(food|meal|diet)\b/i },
  { category: 'attendant_food', rx: /\bvisitor\s*(food|meal)\b/i },
  { category: 'attendant_food', rx: /\bextra\s*(meal|food)\s*(charge|tray)\b/i },
  { category: 'attendant_food', rx: /\b(tea|coffee|milk|snacks?)\s*for\s*(attendant|visitor|relative)/i },

  // Attendant stay / accommodation
  { category: 'attendant_stay', rx: /\battendant\s*(bed|charges?|stay)\b/i },
  { category: 'attendant_stay', rx: /\bvisitor\s*(pass|charges?)\b/i },
  { category: 'attendant_stay', rx: /\bguest\s*(charges?|room)\b/i },

  // Admin / documentation fees
  { category: 'admin_fees', rx: /\bregistration\s*(fee|charge)/i },
  { category: 'admin_fees', rx: /\badmission\s*kit\b/i },
  { category: 'admin_fees', rx: /\bmedical\s*record\s*(fee|charge|copy)/i },
  { category: 'admin_fees', rx: /\b(file|folder)\s*charge\b/i },
  { category: 'admin_fees', rx: /\bservice\s*charge\b/i },
  { category: 'admin_fees', rx: /\bestablishment\s*(fee|charge)/i },

  // Documentation / certificates
  { category: 'documentation', rx: /\b(birth|death)\s*certificate\b/i },
  { category: 'documentation', rx: /\bmedico-?legal\s*case\s*(charge|certificate)/i },
  { category: 'documentation', rx: /\bdischarge\s*summary\s*(extra|duplicate|copy)/i },
  { category: 'documentation', rx: /\bduplicate\s*(report|bill|receipt)\b/i },

  // Transport (non-ambulance)
  { category: 'transport', rx: /\btaxi\s*(fare|charge)/i },
  { category: 'transport', rx: /\bcab\s*(fare|charge)/i },
  { category: 'transport', rx: /\bauto\s*(fare|rickshaw)\b/i },
  { category: 'transport', rx: /\bvehicle\s*parking\b/i },
  { category: 'transport', rx: /\bparking\s*(charge|fee)/i },

  // Comfort / amenity (TV, phone, newspaper, AC, internet)
  { category: 'comfort', rx: /\btv\s*(rental|charge|cable)/i },
  { category: 'comfort', rx: /\btelevision\s*(charge|rental)/i },
  { category: 'comfort', rx: /\btelephone\s*(call|charge|bill)/i },
  { category: 'comfort', rx: /\bphone\s*(call|bill)/i },
  { category: 'comfort', rx: /\bnewspaper\b/i },
  { category: 'comfort', rx: /\bmagazine\b/i },
  { category: 'comfort', rx: /\binternet\s*(charge|wifi)/i },
  { category: 'comfort', rx: /\bwi-?fi\s*charge/i },
  { category: 'comfort', rx: /\bbarber\b/i },

  // Misc consumables typically non-payable (IRDAI list)
  { category: 'miscellaneous_consumables', rx: /\bbed\s*pan\b/i },
  { category: 'miscellaneous_consumables', rx: /\burine\s*(pot|container|bag\s*rental)/i },
  { category: 'miscellaneous_consumables', rx: /\bcrepe\s*bandage\s*(extra|spare)/i },
  { category: 'miscellaneous_consumables', rx: /\b(slipper|chappal|footwear)\b/i },
  { category: 'miscellaneous_consumables', rx: /\bdress\s*(of|for)\s*patient\b/i },

  // Catch-all miscellaneous (very specific phrases only — avoid
  // false positives on medical line items)
  { category: 'miscellaneous', rx: /\bnon[-\s]?medical\b/i },
  { category: 'miscellaneous', rx: /\bnon[-\s]?payable\b/i },
];

export function classifyBillLines(lines: BillLine[]): ClassifyNonMedicalResponse {
  const classified: ClassifiedLine[] = lines.map((line) => {
    const desc = line.description;
    for (const rule of RULES) {
      const m = rule.rx.exec(desc);
      if (m) {
        return {
          description: line.description,
          amountPaise: line.amountPaise,
          medical: false,
          category: rule.category,
          matchedTerm: m[0],
        };
      }
    }
    return {
      description: line.description,
      amountPaise: line.amountPaise,
      medical: true,
      category: null,
      matchedTerm: null,
    };
  });

  let medicalPaise = 0;
  let nonMedicalPaise = 0;
  const categoryBuckets = new Map<NonMedicalCategory, { count: number; amountPaise: number }>();
  for (const line of classified) {
    if (line.medical) {
      medicalPaise += line.amountPaise;
    } else {
      nonMedicalPaise += line.amountPaise;
      if (line.category) {
        const bucket = categoryBuckets.get(line.category) ?? { count: 0, amountPaise: 0 };
        bucket.count += 1;
        bucket.amountPaise += line.amountPaise;
        categoryBuckets.set(line.category, bucket);
      }
    }
  }

  return {
    lines: classified,
    totals: {
      medicalPaise,
      nonMedicalPaise,
      grandTotalPaise: medicalPaise + nonMedicalPaise,
    },
    byCategory: Array.from(categoryBuckets.entries())
      .map(([category, b]) => ({ category, count: b.count, amountPaise: b.amountPaise }))
      // Largest non-medical buckets first — operator skims top of list.
      .sort((a, b) => b.amountPaise - a.amountPaise),
  };
}
