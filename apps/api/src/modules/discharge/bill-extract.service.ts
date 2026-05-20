import {
  type BillOcrExtractRequest,
  type BillOcrExtractResponse,
} from '@claims/contracts';
import { Inject, Injectable } from '@nestjs/common';

import { BILL_OCR_ADAPTER, type BillOcrAdapter } from '../bill-ocr';

// Thin orchestration over the bill-OCR adapter: decode the uploaded
// base64 bytes, run extraction, and map the adapter result onto the
// wire contract. Stateless — no DB, no tenant data crosses, nothing
// persisted (the operator saves the classified bill separately via
// the bill-line-item flow).
@Injectable()
export class BillExtractService {
  constructor(
    @Inject(BILL_OCR_ADAPTER) private readonly billOcr: BillOcrAdapter,
  ) {}

  async extract(input: BillOcrExtractRequest): Promise<BillOcrExtractResponse> {
    const buffer = Buffer.from(input.fileBase64, 'base64');
    const result = await this.billOcr.extractBill({
      buffer,
      contentType: input.contentType,
      originalFilename: input.originalFilename,
    });
    return {
      status: result.status,
      engine: result.engine,
      lines: result.lines,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  }
}
