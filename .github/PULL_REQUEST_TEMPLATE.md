# Summary

<!-- One paragraph: what does this PR change? -->

## Spec section

<!-- Link the section of docs/ this PR implements. e.g.,
docs/14-onboarding-and-auth.md §J-19 setup-wizard step-2 -->

## Tests added

<!-- List unit / integration / e2e / contract tests added in this PR. -->

## Manual test plan

<!-- Steps a reviewer can run to verify. Local commands, expected output. -->

## Migration notes

<!-- New migrations? RLS policy changes? Backfill scripts? Data lifecycle implications? -->

## Breaking changes

<!-- Public-API or contract changes that other modules need to know about. -->

## Doc updates

<!-- Which docs/ file changed in this PR? If none, justify. -->

## Checklist

- [ ] `pnpm lint` clean
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` clean (unit)
- [ ] `pnpm test:integration` clean (RLS canary still green)
- [ ] Error codes added to `reference/error-codes.md` and `@claims/error-codes`
- [ ] OpenAPI updated for new endpoints
- [ ] No PII in logs (uses redacted logger)
- [ ] No new dependency without justification (in commit body)
