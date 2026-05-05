import { Injectable, type PipeTransform } from '@nestjs/common';
import { type ZodType, type ZodTypeDef } from 'zod';

// Generic over output type only. Schemas with .transform() / .preprocess()
// have differing input ↔ output, so we don't constrain the input.
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T, ZodTypeDef, unknown>) {}

  transform(value: unknown): T {
    // Throws ZodError on failure; the DomainExceptionFilter maps that to
    // VALIDATION_FAILED ProblemDetails. Do not catch here.
    return this.schema.parse(value);
  }
}
