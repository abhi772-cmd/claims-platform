// Slice BR — PII access HTTP interceptor. Writes a data_access_event
// row after every successful response from a `@LogsPiiAccess`-tagged
// handler. We log AFTER success on purpose: failed reads (4xx/5xx)
// don't usually constitute "the operator saw the data" — those are
// audit_log territory. If a future use case needs to log denied
// reads too (suspicious-activity detection), wrap the catchError
// branch.
//
// Actor + IP + UA come from the request; purpose + resourceType +
// action come from the decorator metadata. The interceptor doesn't
// invent values — explicit metadata at the controller is the
// contract.

import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Request } from 'express';
import { type Observable, tap } from 'rxjs';

import { DataAccessLogService } from './data-access-log.service';
import {
  LOGS_PII_ACCESS_METADATA,
  type LogsPiiAccessOptions,
} from './logs-pii-access.decorator';

@Injectable()
export class PiiAccessInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessLog: DataAccessLogService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const opts = this.reflector.get<LogsPiiAccessOptions | undefined>(
      LOGS_PII_ACCESS_METADATA,
      context.getHandler(),
    );
    if (!opts) return next.handle();

    const req = context.switchToHttp().getRequest<Request & {
      user?: Express.AuthenticatedUser;
    }>();

    return next.handle().pipe(
      tap({
        next: () => {
          // Best-effort fire-and-forget. The HTTP response has
          // already been computed; logging failures must not
          // 500 the caller. We don't await.
          const user = req.user;
          if (!user) return; // anonymous request — handler shouldn't have hit this code path
          void this.accessLog
            .record({
              tenantId: user.tenantId,
              actorUserId: user.userId,
              actorType: 'user',
              resourceType: opts.resourceType,
              action: opts.action,
              purpose: opts.purpose,
              ipAddress: req.ip ?? null,
              userAgent: req.get('user-agent') ?? null,
            })
            .catch(() => {
              // Swallow — see comment above. The Logger in
              // DataAccessLogService will surface the underlying
              // error so this isn't a silent black hole at the
              // log-aggregation layer.
            });
        },
      }),
    );
  }
}
