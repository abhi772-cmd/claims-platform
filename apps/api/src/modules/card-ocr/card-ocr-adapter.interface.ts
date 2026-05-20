// CardOcrAdapter abstracts insurance / TPA card field extraction at
// intake. Three modes via CARD_OCR_MODE:
//   off  — DisabledCardOcrAdapter: every result is 'skipped'. Operator
//          types the card details into the new-case form by hand.
//   stub — StubCardOcrAdapter: deterministic fixtures matched against
//          sentinel strings in the buffer, for tests.
//   real — HttpCardOcrAdapter: POSTs the bytes to the OCR machine's
//          /extract-card route and parses the fields back.
//
// Stateless / buffer-only, same as BillOcrAdapter — intake card scan
// uploads bytes directly; nothing is stored.

export const CARD_OCR_ADAPTER = Symbol('CARD_OCR_ADAPTER');

export interface CardExtractInput {
  buffer: Buffer;
  contentType?: string;
  originalFilename?: string;
}

// Fields read off a card. Shape matches @claims/contracts
// CardOcrFields so the controller maps straight through.
export interface CardOcrFields {
  insurerName?: string;
  tpaName?: string;
  policyNumber?: string;
  memberId?: string;
  insuredName?: string;
  sumInsuredPaise?: number;
  validFrom?: string;
  validTo?: string;
  dateOfBirth?: string;
}

export type CardExtractStatus = 'extracted' | 'low_confidence' | 'skipped' | 'failed';

export interface CardExtractResult {
  status: CardExtractStatus;
  engine: string;
  // Populated on 'extracted' / 'low_confidence'.
  fields?: CardOcrFields;
  error?: string;
}

export interface CardOcrAdapter {
  extractCard(input: CardExtractInput): Promise<CardExtractResult>;
}
