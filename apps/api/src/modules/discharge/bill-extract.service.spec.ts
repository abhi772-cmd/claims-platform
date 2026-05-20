import { type BillOcrAdapter } from '../bill-ocr';
import { BillExtractService } from './bill-extract.service';

describe('BillExtractService', () => {
  function makeService(adapter: BillOcrAdapter): BillExtractService {
    return new BillExtractService(adapter);
  }

  it('decodes base64 and forwards bytes + hints to the adapter', async () => {
    let captured: { buffer: Buffer; contentType?: string; originalFilename?: string } | null = null;
    const adapter: BillOcrAdapter = {
      extractBill: async (input) => {
        captured = input;
        return {
          status: 'extracted',
          engine: 'stub',
          lines: [{ description: 'Surgery', amountPaise: 4500000 }],
        };
      },
    };
    const service = makeService(adapter);

    const fileBase64 = Buffer.from('STUB-BILL-CLEAN').toString('base64');
    const res = await service.extract({
      fileBase64,
      contentType: 'application/pdf',
      originalFilename: 'bill.pdf',
    });

    expect(captured).not.toBeNull();
    expect(captured!.buffer.toString('utf8')).toBe('STUB-BILL-CLEAN');
    expect(captured!.contentType).toBe('application/pdf');
    expect(captured!.originalFilename).toBe('bill.pdf');
    expect(res.status).toBe('extracted');
    expect(res.lines[0]?.description).toBe('Surgery');
  });

  it('propagates the error string on failure', async () => {
    const adapter: BillOcrAdapter = {
      extractBill: async () => ({
        status: 'failed',
        engine: 'http-remote',
        lines: [],
        error: 'OCR returned HTTP 503',
      }),
    };
    const res = await makeService(adapter).extract({
      fileBase64: Buffer.from('x').toString('base64'),
      contentType: 'application/pdf',
    });
    expect(res.status).toBe('failed');
    expect(res.error).toBe('OCR returned HTTP 503');
  });

  it('omits the error field when the adapter returns none', async () => {
    const adapter: BillOcrAdapter = {
      extractBill: async () => ({ status: 'low_confidence', engine: 'stub', lines: [] }),
    };
    const res = await makeService(adapter).extract({
      fileBase64: Buffer.from('x').toString('base64'),
      contentType: 'image/png',
    });
    expect(res.status).toBe('low_confidence');
    expect(res.error).toBeUndefined();
  });
});
