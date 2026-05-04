import { type PasswordPolicyDescriptor } from '@claims/contracts';
import { Injectable } from '@nestjs/common';
import { hash, verify } from 'argon2';

import { BreachList } from './breach-list';
import {
  PasswordBreachedError,
  PasswordReusedError,
  PasswordTooWeakError,
} from '../../common/errors/auth-errors';
import { type TenantPrisma } from '../../types/express';

const POLICY: PasswordPolicyDescriptor = {
  minLength: 12,
  maxLength: 256,
  requireLower: true,
  requireUpper: true,
  requireDigit: true,
  requireSymbol: true,
  historyDepth: 5,
};

export interface PasswordValidationContext {
  tenantId: string;
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
}

@Injectable()
export class PasswordPolicyService {
  constructor(private readonly breachList: BreachList) {}

  // Public read of the policy — used by the web app's strength meter
  // and by tests.
  describe(): PasswordPolicyDescriptor {
    return POLICY;
  }

  // Static checks — length, character classes, contextual personal-data
  // matches. Throws PasswordTooWeakError if any fail. Pure (no DB / fs).
  validateShape(password: string, ctx: Pick<PasswordValidationContext, 'email' | 'firstName' | 'lastName'>): void {
    if (password.length < POLICY.minLength) {
      throw new PasswordTooWeakError(`Password must be at least ${POLICY.minLength} characters.`);
    }
    if (password.length > POLICY.maxLength) {
      throw new PasswordTooWeakError(`Password must be no more than ${POLICY.maxLength} characters.`);
    }
    if (POLICY.requireLower && !/[a-z]/.test(password)) {
      throw new PasswordTooWeakError('Password must include a lowercase letter.');
    }
    if (POLICY.requireUpper && !/[A-Z]/.test(password)) {
      throw new PasswordTooWeakError('Password must include an uppercase letter.');
    }
    if (POLICY.requireDigit && !/[0-9]/.test(password)) {
      throw new PasswordTooWeakError('Password must include a digit.');
    }
    if (POLICY.requireSymbol && !/[^A-Za-z0-9]/.test(password)) {
      throw new PasswordTooWeakError('Password must include a symbol.');
    }
    // Contextual checks: don't allow the email local-part, first name, or
    // last name to appear inside the password (case-insensitive). These
    // are the easiest dictionary-style guesses for an attacker who knows
    // the user.
    const lower = password.toLowerCase();
    const localPart = ctx.email.split('@')[0]?.toLowerCase() ?? '';
    const tokens = [localPart, ctx.firstName, ctx.lastName]
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length >= 4);
    for (const token of tokens) {
      if (lower.includes(token)) {
        throw new PasswordTooWeakError("Password can't include your name or email.");
      }
    }
  }

  // Breach list check. Synchronous (in-memory set lookup).
  validateNotBreached(password: string): void {
    if (this.breachList.contains(password)) {
      throw new PasswordBreachedError();
    }
  }

  // History check. Pulls the most recent N (POLICY.historyDepth) hashes
  // for the user (ordered newest first) and runs argon2.verify against
  // each. The current passwordHash counts as the most recent — callers
  // pass it in via the user lookup since it's already in scope.
  // Throws PasswordReusedError on match.
  async validateNotReused(
    tx: TenantPrisma,
    userId: string,
    currentPasswordHash: string | null,
    candidate: string,
  ): Promise<void> {
    if (currentPasswordHash && currentPasswordHash.startsWith('$argon2')) {
      if (await verify(currentPasswordHash, candidate)) {
        throw new PasswordReusedError();
      }
    }
    if (POLICY.historyDepth <= 0) return;
    const history = await tx.passwordHistory.findMany({
      where: { userId },
      orderBy: { changedAt: 'desc' },
      take: POLICY.historyDepth,
    });
    for (const row of history) {
      if (await verify(row.passwordHash, candidate)) {
        throw new PasswordReusedError();
      }
    }
  }

  // Convenience — runs the three checks in order. Use this when you
  // already have a tx open. Static checks first (fast), breach list,
  // then history (DB hit).
  async validateAll(
    tx: TenantPrisma,
    ctx: PasswordValidationContext,
    currentPasswordHash: string | null,
    candidate: string,
  ): Promise<void> {
    this.validateShape(candidate, ctx);
    this.validateNotBreached(candidate);
    await this.validateNotReused(tx, ctx.userId, currentPasswordHash, candidate);
  }

  // Hash the password for storage. Uses the argon2 defaults; matches
  // the rest of the codebase.
  async hashForStorage(password: string): Promise<string> {
    return hash(password);
  }
}
