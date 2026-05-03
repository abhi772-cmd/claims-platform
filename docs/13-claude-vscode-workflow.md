# 13 — Working with Claude in VS Code

This is the operating manual for vibe-coding this project with Claude as your pair. It's written for **you** (the developer/PM) — Claude doesn't need to read this; it reads `CLAUDE.md` for instructions.

---

## TL;DR

1. Use **Claude Code** (the CLI/IDE integration), not just chat.
2. Open the repo at the root — Claude auto-loads `CLAUDE.md`.
3. Reference doc sections explicitly in prompts: "implement J-04 from `docs/05-user-journeys.md`".
4. Use **plan mode** for anything spanning >3 files.
5. Use **slash commands** (`/init`, `/clear`, `/test`, `/security-review`).
6. Use **skills** (the `/docx`, `/xlsx`, `/pdf` ones for stakeholder artefacts).
7. Keep PRs small — one feature, one branch, one PR.

---

## Setting up Claude Code in VS Code

If you haven't already:

1. Install the Claude Code extension (or use the standalone CLI: `npm install -g @anthropic-ai/claude-code`).
2. Authenticate with your Anthropic account (`claude login`).
3. Open the repo root: `cd /path/to/claims-platform && code .`
4. The extension loads `CLAUDE.md` and any `**/CLAUDE.md` it finds in the workspace.

Recommended VS Code extensions (committed in `.vscode/extensions.json`):
- Claude Code
- Prisma
- ESLint
- Prettier
- Tailwind CSS IntelliSense
- TypeScript Vue Plugin (for any Next.js Vue interop, unlikely needed)
- GitLens

---

## How CLAUDE.md works

Claude Code reads:
- The repo-root `CLAUDE.md` (highest priority — universal rules)
- Any `**/CLAUDE.md` deeper in the tree (module-specific rules)
- The system reminder to follow these instructions

Your `claims-platform/CLAUDE.md` already declares:
- Hard rules (TypeScript strict, RLS, error system, etc.)
- File locations (`docs/`, `reference/`)
- When to ask vs. when to act
- Commit conventions

Optional: add `apps/api/CLAUDE.md` with API-specific rules and `apps/web/CLAUDE.md` for frontend specifics. Keep these short — overrides, not duplication.

---

## How to write a prompt that works

The single biggest mistake: under-specifying. The single biggest fix: cite the doc and be explicit about the deliverable.

### Bad prompt

> "Add the preauth flow"

What Claude does: invents something plausible, ignores half your spec, generates 600 lines of code you have to undo.

### Good prompt

> "Implement journey J-01 (NHCX cashless preauth happy path) from `docs/05-user-journeys.md`. Build the API endpoints listed there. Use the Prisma models in `docs/03-data-model.md`. Status transitions per `docs/04-state-machines.md`. Errors per `docs/10-error-modal-system.md` and `reference/error-codes.md`. NHCX integration patterns are already in `apps/api/src/integrations/nhcx/` — reuse, don't duplicate. Frontend pages live at `apps/web/app/(dashboard)/preauth/`. Tests under `apps/api/test/integration/preauth.e2e-spec.ts`. Submit a plan first showing files to be touched and the order."

What Claude does: reads the docs, drafts a plan, you review, it implements.

### Better prompt (for unfamiliar tasks)

> "I want to add a 'pre-auth diff' view that shows the user the difference between the original preauth and any enhancement requests. This isn't in the spec yet. Read `docs/04-state-machines.md` and `docs/06-modules.md`, propose: (1) what data we need to capture (and whether the schema needs changes), (2) what API endpoint shape works, (3) what UI design fits the existing modal/component patterns in `docs/09-design-system.md`. Don't write code yet — write the spec addition that should go into the relevant doc, then we'll review and implement."

What Claude does: reads, proposes, asks questions, doesn't go off-piste.

---

## Plan mode

For anything beyond a one-file tweak, use plan mode:

```
/plan
```

Then describe the task. Claude produces:
- File list
- Function signatures
- Migration plan
- Test plan
- Risk callouts

You review, push back, iterate. Then approve. Then implement.

If Claude writes code without showing the plan first for a multi-file change, **stop** and ask for the plan. It's faster.

---

## Slash commands worth knowing

- `/init` — create or update `CLAUDE.md` based on the codebase (use this when the project's structure or conventions evolve).
- `/clear` — clear the context window. Use between unrelated tasks; otherwise old context bleeds in.
- `/plan` — switch to plan mode for the next instruction.
- `/test` — run the project's test suite.
- `/security-review` — review the current branch for security issues.
- `/review` — review the pending changes on the current branch as if you were a reviewer.
- `/<skill-name>` — invoke a skill. See below.

You can write your own slash commands by adding markdown files to `.claude/commands/`. For example:

```
.claude/commands/add-error-code.md
```

```markdown
You are adding a new error code. Steps:
1. Read reference/error-codes.md to see the existing pattern.
2. Add a row in the appropriate section.
3. Update apps/api/src/modules/<module>/errors/.
4. Update apps/web/components/modals/error-map.ts.
5. Add a unit test that triggers the new error and asserts the response shape.
6. Run /test.
```

Then `/add-error-code` runs that workflow.

---

## Skills — what they are and when to use

Skills are pre-packaged playbooks Claude can run. The ones available in this project:

### `docx` — for Word documents

When you need to produce a stakeholder-facing PRD, an executive summary, a proposal, or a board memo.

**Use it for**: handing the PRD to a hospital stakeholder, generating a one-pager for sales, producing a compliance attestation for IRDAI.

**Don't use it for**: routine code documentation. Markdown is the canonical format for that.

```
/docx
Produce a 4-page executive summary of this claims platform's value proposition for a hospital CFO. Pull from docs/01-overview-and-decisions.md (problem, scope) and docs/05-user-journeys.md (J-13 CFO journey). Tone: professional, confidence without overclaiming.
```

### `xlsx` — for spreadsheets

For payer master templates, denial taxonomy, package master sync, hospital onboarding checklists, billing code uploads, ICD/SNOMED tables, audit reports.

```
/xlsx
Generate a payer master template Excel file with columns matching the Payer model in docs/03-data-model.md. Pre-populate with the major TPAs (Medi Assist, Paramount, FHPL, Health India). Include a sheet with column-level data validation rules.
```

### `pdf` — for PDF processing

For reading sample EOB PDFs to inform the parser, producing claim-summary PDFs to email to patients/insurers, generating audit reports as PDFs.

```
/pdf
Read the sample EOBs in /sample-eobs/. Extract per-payer the structure of approved/deducted line items. Suggest the JSON schema the LLM extractor should target.
```

### `pptx` — for presentations

For pitch decks, partner pitches, investor updates.

### `consolidate-memory` — meta

Cleans up Claude's memory files when they get cluttered. Run periodically.

### Slash command vs skill

Slash commands are pinned workflows you re-use. Skills are domain capabilities. Use slash commands for "do this same thing again" and skills for "produce this kind of artefact."

---

## How to use the PRD effectively

The PRD here is structured so Claude can read it incrementally.

**For a small task**: just point to one section.
> "Implement the SLA evaluator described in section 'Communication & Tracking' of `docs/06-modules.md`."

**For a feature**: point to journey, module, and any cross-cutting docs.
> "Implement J-09 (denial and appeal) using the modules described in `docs/06-modules.md`, the schema in `docs/03-data-model.md`, and the error system in `docs/10-error-modal-system.md`."

**For something off-spec**: ask Claude to extend the spec first.
> "I want to add a 'patient-side portal' for reimbursement claims so patients can submit themselves. Propose what to add to `docs/05-user-journeys.md` and `docs/06-modules.md`. Don't code yet."

**Avoid copying doc content into prompts.** Reference by path. Claude reads the file. The shorter your prompt, the less it can misunderstand.

---

## Iterative loop

The day-to-day rhythm:

1. **Pick a journey or module slice.** Open the relevant doc(s) yourself first. If it's underspecified, fix the doc.
2. **Plan with Claude.** "Implement section X. Show me a plan."
3. **Review the plan.** Push back on anything unclear, anything that crosses module boundaries, anything that skips tests or docs.
4. **Approve.** Claude implements.
5. **Run tests.** `/test` or `pnpm test`. Iterate on failures.
6. **Self-review.** `/review` to get a second look from Claude before you do your own pass.
7. **Commit and push.** Conventional commit message.
8. **PR.** Use the template; reference the spec sections.
9. **Merge after review.**
10. **/clear** the context window for the next task.

---

## Things to refuse / push back on

If Claude proposes:

- A new dependency without justification → ask why, suggest alternatives.
- Bypassing RLS for "performance" → no.
- Skipping tests because "it's a small change" → no.
- Modifying DigiSparsh's existing code from this repo → wrong repo.
- Hardcoding tenant-specific behaviour in shared modules → use `tenant_config`.
- Inventing a new error code without updating `reference/error-codes.md` → make it update both.
- Adding a `console.log` for debugging → use the structured logger.

---

## When Claude gets stuck

Symptoms: it loops on the same fix, generates code that doesn't compile after multiple iterations, suggests something inconsistent with the spec.

Remedy:
- `/clear` and start fresh with a tighter prompt.
- Provide one concrete example of the desired output.
- Switch to plan mode and walk through manually.
- If the spec is ambiguous, fix the spec first.

---

## How to keep the project healthy

- Once a week, run `/security-review` on `main`.
- Once a month, run `/init` to refresh `CLAUDE.md` with new conventions you've adopted.
- Once a quarter, regenerate the API client from OpenAPI to catch contract drift.
- Once a release, walk the user-journey docs end-to-end against the deployed app to verify the PRD is still accurate.

---

## A note on cost and latency

- Use Sonnet for routine work. Use Opus only for complex multi-file refactors or architectural questions.
- Long context window = more cost; `/clear` between unrelated tasks.
- Plan mode is cheaper than implementation mode (less code generated up front).

---

## Recommended `.vscode/settings.json` snippet

```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": "explicit",
    "source.organizeImports": "explicit"
  },
  "typescript.tsdk": "node_modules/typescript/lib",
  "typescript.preferences.importModuleSpecifier": "non-relative",
  "files.exclude": {
    "**/.next": true,
    "**/dist": true,
    "**/.turbo": true
  },
  "search.exclude": {
    "**/node_modules": true,
    "**/dist": true,
    "**/.next": true
  }
}
```
