// Slice AT — unit coverage for the inbound rate-limit guard. Uses
// jest fake timers to roll the window deterministically without
// real-time waits.

import { type ExecutionContext, HttpException } from '@nestjs/common';
import { type ConfigService } from '@nestjs/config';

import { NhcxInboundRateLimitGuard } from './nhcx-inbound-rate-limit.guard';
import { type AppConfig } from '../../../config/configuration';

function makeGuard(limitPerMinute: number): NhcxInboundRateLimitGuard {
  const config = {
    get(key: string): unknown {
      if (key === 'NHCX_INBOUND_RATE_LIMIT_PER_MINUTE') return limitPerMinute;
      return undefined;
    },
  } as unknown as ConfigService<AppConfig, true>;
  return new NhcxInboundRateLimitGuard(config);
}

const fakeContext = {} as ExecutionContext;

describe('NhcxInboundRateLimitGuard', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-07T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('limit=0 disables the guard (every call passes)', () => {
    const guard = makeGuard(0);
    for (let i = 0; i < 1000; i += 1) {
      expect(guard.canActivate(fakeContext)).toBe(true);
    }
  });

  it('allows up to `limit` requests in the first minute', () => {
    const guard = makeGuard(5);
    for (let i = 0; i < 5; i += 1) {
      expect(guard.canActivate(fakeContext)).toBe(true);
    }
  });

  it('throws 429 on the (limit+1)th request inside the same window', () => {
    const guard = makeGuard(3);
    for (let i = 0; i < 3; i += 1) guard.canActivate(fakeContext);
    expect(() => guard.canActivate(fakeContext)).toThrow(HttpException);
    try {
      guard.canActivate(fakeContext);
    } catch (err) {
      expect((err as HttpException).getStatus()).toBe(429);
    }
  });

  it('keeps rejecting subsequent requests in the same window after the boundary', () => {
    const guard = makeGuard(2);
    guard.canActivate(fakeContext);
    guard.canActivate(fakeContext);
    expect(() => guard.canActivate(fakeContext)).toThrow();
    expect(() => guard.canActivate(fakeContext)).toThrow();
    expect(() => guard.canActivate(fakeContext)).toThrow();
  });

  it('rolls the window after 60s and admits a fresh batch', () => {
    const guard = makeGuard(2);
    guard.canActivate(fakeContext);
    guard.canActivate(fakeContext);
    expect(() => guard.canActivate(fakeContext)).toThrow();

    // Advance one full window — the next call resets the counter.
    jest.advanceTimersByTime(60_000);
    expect(guard.canActivate(fakeContext)).toBe(true);
    expect(guard.canActivate(fakeContext)).toBe(true);
    expect(() => guard.canActivate(fakeContext)).toThrow();
  });

  it('does not roll the window early at 59s', () => {
    const guard = makeGuard(1);
    guard.canActivate(fakeContext);
    jest.advanceTimersByTime(59_000);
    expect(() => guard.canActivate(fakeContext)).toThrow();
  });

  it('logs the boundary exactly once per window', () => {
    const guard = makeGuard(1);
    const warnSpy = jest
      .spyOn(guard['log'], 'warn')
      .mockImplementation(() => undefined);
    guard.canActivate(fakeContext);
    // Boundary firing — the (limit+1)th call:
    expect(() => guard.canActivate(fakeContext)).toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // Subsequent rejections in the same window stay quiet.
    expect(() => guard.canActivate(fakeContext)).toThrow();
    expect(() => guard.canActivate(fakeContext)).toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
