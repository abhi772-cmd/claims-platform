import { Injectable, type PipeTransform } from '@nestjs/common';
import { type ZodSchema } from 'zod';

@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    // Throws ZodError on failure; the DomainExceptionFilter maps that to
    // VALIDATION_FAILED ProblemDetails. Do not catch here.
    return this.schema.parse(value);
  }
}
