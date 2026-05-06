import {
  type NhcxInboundAccept,
  type NhcxInboundOperation,
  NhcxInboundOperationSchema,
  type NhcxInboundRequest,
  NhcxInboundRequestSchema,
} from '@claims/contracts';
import { Body, Controller, Headers, HttpCode, Logger, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { NhcxInboundService } from './nhcx-inbound.service';
import { ValidationFailedError } from '../../../common/errors/validation-errors';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';

// Public NHCX gateway webhook. The HCX gateway POSTs here for every
// callback (eligibility, preauth, claim, communication). No auth guard
// is appropriate at the HTTP layer — the gateway uses TLS for transport
// security and the JWE payload itself is the cryptographic guarantee
// that the message came from a holder of the matching public key.
//
// Contract:
//   - We MUST return 200 within the gateway's timeout (typically 5s)
//     even if our processing fails internally. Returning a 4xx/5xx
//     causes NHA to retry indefinitely with the same correlationId,
//     which we then have to reconcile manually.
//   - We persist the raw payload + return 200 BEFORE attempting any
//     decrypt / parse. The decrypt + dispatch happens asynchronously
//     after the response is sent.
//   - Operation type comes from the `x-hcx-operation` header (a
//     known set per HCX 0.7.1). correlationId from `x-hcx-correlation-id`.
@ApiTags('nhcx-inbound')
@Controller('nhcx/inbound')
export class NhcxInboundController {
  private readonly log = new Logger(NhcxInboundController.name);

  constructor(private readonly inbound: NhcxInboundService) {}

  @Post()
  @HttpCode(200)
  async receive(
    @Headers('x-hcx-correlation-id') correlationIdHeader: string | undefined,
    @Headers('x-hcx-operation') operationHeader: string | undefined,
    @Headers('x-hcx-sender-code') senderCodeHeader: string | undefined,
    @Body(new ZodValidationPipe(NhcxInboundRequestSchema)) body: NhcxInboundRequest,
  ): Promise<NhcxInboundAccept> {
    if (!correlationIdHeader) {
      throw new ValidationFailedError({
        'x-hcx-correlation-id': ['Header is required.'],
      });
    }
    const opParse = NhcxInboundOperationSchema.safeParse(operationHeader);
    if (!opParse.success) {
      throw new ValidationFailedError({
        'x-hcx-operation': [
          `Header must be one of: coverageeligibility/on_check, preauth/on_submit, claim/on_submit, communication/request. Got: ${String(operationHeader)}`,
        ],
      });
    }
    const operation: NhcxInboundOperation = opParse.data;

    const dispatchInput = {
      correlationId: correlationIdHeader,
      operation,
      senderCode: senderCodeHeader ?? null,
      body,
      receivedAt: new Date(),
    };

    const result = await this.inbound.receive(dispatchInput);
    if (result.outcome === 'accepted') {
      // Fire-and-forget the processing step. The .catch handles any
      // unhandled rejection so it doesn't surface as an
      // UnhandledPromiseRejection at process level. Failures are
      // also recorded on the integration_message row inside process().
      void this.inbound.process(result.inboundMessageId, dispatchInput).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.log.error(
          `unexpected throw from nhcx inbound process correlationId=${correlationIdHeader} err=${message}`,
        );
      });
    } else {
      this.log.log(
        `nhcx inbound outcome=${result.outcome} correlationId=${correlationIdHeader}`,
      );
    }

    return { status: 'accepted', correlationId: correlationIdHeader };
  }
}
