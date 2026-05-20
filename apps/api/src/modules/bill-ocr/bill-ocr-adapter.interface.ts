// BillOcrAdapter abstracts hospital-bill line-item extraction. Three
// modes via BILL_OCR_MODE:
//   off  — DisabledBillOcrAdapter: every result is 'skipped'. The
//          operator pastes the bill into the classifier by hand.
//   stub — StubBillOcrAdapter: deterministic fixtures matched against
//          sentinel strings in the buffer, so tests can drive the
//          "upload bill → lines appear" UX without an OCR engine.
//   real — HttpBillOcrAdapter: POSTs the bytes to the bill-OCR
//          inference service (the eob-ocr-machine's /extract-bill
//          route) and parses the line items back.
//
// Deliberately leaner than EobOcrAdapter: the bill-extract flow is
// stateless (the operator uploads bytes directly; nothing is stored),
// so the adapter only consumes a buffer — there's no (bucket, key)
// storage-fetch path.

export const BILL_OCR_ADAPTER = Symbol('BILL_OCR_ADAPTER');

export interface BillExtractInput {
  // The bill bytes. The controller decodes the request's base64 into
  // this buffer.
  buffer: Buffer;
  // MIME type hint — the inference service rasterises PDFs differently
  // from single-page images.
  contentType?: string;
  // Original filename, for logging under a stable identifier.
  originalFilename?: string;
}

// One parsed bill row. Shape matches @claims/contracts BillLine so the
// non-medical classifier consumes it directly. `amountPaise` is an int
// in paise (the platform money unit).
export interface BillOcrLine {
  description: string;
  amountPaise: number;
}

export type BillExtractStatus =
  // OCR ran and produced line items.
  | 'extracted'
  // OCR ran but read nothing usable — operator pastes/keys the bill.
  | 'low_confidence'
  // The 'off' adapter, or a content type the engine doesn't accept.
  | 'skipped'
  // Engine error: timeout, bad PDF, model crash. `error` is populated.
  | 'failed';

export interface BillExtractResult {
  status: BillExtractStatus;
  // Free-form engine identifier ('disabled', 'stub', 'ollama:…').
  engine: string;
  // Populated when status='extracted'. Empty otherwise.
  lines: BillOcrLine[];
  // Free-form on status='failed'.
  error?: string;
}

export interface BillOcrAdapter {
  extractBill(input: BillExtractInput): Promise<BillExtractResult>;
}
