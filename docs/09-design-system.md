# 09 — Design System

This doc captures the visual language, component patterns, and modal-first error UX for the platform. Colors and typography are derived from the existing DigiSparsh palette and modernised for accessibility and consistency.

The actual design tokens live in **`packages/ui-tokens/src/tokens.css`** (CSS variables + component-recipe classes). It is imported once in `apps/web/app/globals.css`; `apps/web/tailwind.config.ts` re-exposes the tokens as Tailwind theme values. The matching high-fidelity mockups live in the **"DigiSparsh Healthcare Claims Platform"** Stitch project (design system asset *"DigiSparsh Glass Interface"*) — that project is the visual source of truth for layout and component appearance; this doc and `tokens.css` are the source of truth for the values.

---

## Brand identity (carried over)

- **Primary color** — Teal `#00666E` in the live token set (Stitch-canonical primary at `--color-primary-600` in `packages/ui-tokens/src/tokens.css`). The original DigiSparsh brand teal `#008F99` lives on as the lighter mid-tone `--color-primary-500` (and is kept verbatim in the now-historical `reference/tokens.css`). Used for navigation, headings, primary semantic emphasis, glass tints and ambient shadows.
- **Accent color** — Amber `#FAA71A`. Reserved for primary CTAs, action confirmations, and critical status — kept sparing so it "pops" against the cool glass.
- **Body text** — Dark slate `#363A44`. Same as the existing platform's `label` color.
- **Surface** — Frosted-glass white cards floating over a teal-and-amber radial mesh wash on warm off-white `#F4F8FA`.
- **Logo** — Existing DigiSparsh logo applies; tenant logos override on tenant-branded views.

The result is a product that feels like the DigiSparsh family but cleaner, more spacious, and built for hour-after-hour use.

---

## Visual language — glassmorphism + bento

The interface theme is **"Clarity through Depth"**: a complex, data-heavy healthcare SaaS made to feel lightweight via frosted-glass layers, with claim data organised into a rhythmic bento grid.

### Layers / elevation

Depth comes from glass and ambient light, not hard drop-shadows.

| Level | What | Token recipe |
|---|---|---|
| 0 — Canvas | The radial mesh wash | `--bg-app-gradient` on `html, body` (teal glow top-left ~22%, amber glow top-right ~10%, over `#F4F8FA → #F8FAFC`), `background-attachment: fixed` |
| 1 — Cards | Frosted panels — stat tiles, panels, list/table chrome | `.glass` → `rgba(255,255,255,.70)`, `backdrop-filter: blur(24px) saturate(140%)`, 1px white hairline border (`--glass-border`), `box-shadow: inset white hairline + --shadow-md` |
| 2 — Modals / overlays | Dialogs, the auth card | `.glass-strong` → `rgba(255,255,255,.85)`, `blur(40px) saturate(160%)`, `--shadow-lg` (use `--shadow-modal` for true overlays) |
| — | Teal-tinted glass for "resolved/positive" callouts | `.glass-tint` → `rgba(232,246,247,.58)` with a `rgba(0,143,153,.18)` border |

`.glass-card` adds `border-radius: var(--radius-lg)` (12px) + `padding: var(--space-5)`.

**Shadows are ambient teal**, never pure black: `--shadow-{sm,md,lg,xl}` are `rgba(0,105,112, .07/.10/.12/.16)`; `--shadow-modal` is `rgba(0,105,112,.18)`.

### Shape language (hybrid)

- **Containers / cards / glass surfaces** → `--radius-lg` = **12px** (Stitch xl).
- **Inputs, sidebar items, inner panels** → `--radius-md` = **8px** (Stitch lg).
- **Action elements — CTAs and status pills** → `--radius-pill` = **9999px** (full pill). The radius contrast between rounded containers and pill triggers is intentional: it tells the user what's clickable.

### App shell

- **Sidebar** — a solid structural anchor that deliberately *breaks* the glass aesthetic: deep-teal vertical gradient `--sidebar-bg` (`#0d7a82 → #075c63`), 240px, sticky full-height. Logo sits in a white pill; nav is grouped (Operations / Compliance / Tenant admin / Account) with icon + sub-label per item; active item = solid white pill with teal text (`.sidebar-item--active`); a translucent user card pins to the bottom.
- **Top bar** — 64px, sticky, `.glass`; breadcrumb + page title on the left, tenant-status pill + amber "＋ New case" CTA on the right.
- **Auth pages** — split layout: deep-teal brand strip on `lg+` (logo pill, "Claims, simplified for Indian hospitals.", amber-dot feature bullets, copyright); the form sits in a `.glass .glass-strong` card via the shared `<AuthCard>` wrapper (mobile-only logo pill, optional teal eyebrow / `text-2xl` title / subtitle, `tone` prop tinting for terminal states).

### Bento grid

`.bento-grid` — `grid-template-columns: repeat(4, 1fr)`, `grid-auto-rows: minmax(120px, auto)`, `grid-auto-flow: dense`, 16px gap. Tiles claim space with `.bento-wide` (span 2), `.bento-tall` (span 2 rows), `.bento-hero` (2×2). Collapses to 2 columns at `max-width: 900px`. Used on the dashboard home, the profile hub, and the compliance/remittance stat rows.

### Primary CTA

`.btn-cta` — pill-shaped, `linear-gradient(180deg, #FAB23A → #FAA71A)`, dark text (`--color-neutral-900`), `font-weight: 600`, `padding: 10px 20px`, soft amber glow `0 4px 15px rgba(250,167,26,.30)` (`0 8px 22px / .36` on hover, plus a `translateY(-1px)` lift). Add `w-full` for full-width form submits. Secondary actions use a white glass button with teal/neutral text or a teal-outline button; destructive actions use a `danger-`outline button.

### Eyebrows / labels

Uppercase, `--tracking-eyebrow` = `0.12em`, `--font-size-eyebrow` = `10.5px`, weight 600, `text-primary-700` (or `text-neutral-500` for muted sections). Headings carry slight negative tracking (`--tracking-h1` `-0.02em`, `--tracking-h2` `-0.01em`, applied globally to `h1`/`h2`).

---

## Color tokens

The full token set is in `packages/ui-tokens/src/tokens.css`. Summary:

```
--color-primary-600    #00666E    Stitch-canonical primary (live)
--color-primary-500    #008F99    Original DigiSparsh brand teal (lighter mid-tone)
--color-accent-500     #FAA71A    CTA amber (kept exactly)
--color-neutral-700    #363A44    Body text (kept exactly)
--bg-page              #F8FAFC    Page background (modernised from #F5F5F5)
```

Plus a 9-step scale on each (50–900) and full semantic states (success, warning, danger, info).

**WCAG AA**: text colors verified at smallest used size against background. Hover/active variants (700 step on each) ensure CTAs remain readable.

---

## Typography

```
--font-sans: 'Inter', 'DM Sans', 'Segoe UI', Roboto, system-ui, sans-serif;
```

**Inter** as primary (modern SaaS default, sharp at small sizes, excellent number rendering for tables). **DM Sans** as fallback (already loaded in DigiSparsh). System fonts thereafter.

### Type scale

```
xs    11px / 16px lh     (helper text, badges)
sm    13px / 18px lh     (table cells, dense forms)
base  14px / 20px lh     (body)
md    16px / 24px lh     (default for prose)
lg    18px / 26px lh     (emphasized body)
xl    22px / 30px lh     (h3)
2xl   28px / 36px lh     (h2)
3xl   36px / 44px lh     (h1)
```

### Weights

```
Regular  400      body
Medium   500      labels, badges
Semibold 600      headings, emphasized, eyebrows
Bold     700      page titles, key callouts
```

### Tracking & eyebrows

```
h1            -0.02em      tight; applied globally to <h1>
h2            -0.01em      tight; applied globally to <h2>
eyebrow       +0.12em      uppercase section labels — 10.5px / 600 / text-primary-700
```

Page titles in app surfaces render at `text-2xl font-bold` (`<h1>`); marketing/auth headings can go up to 36px (`--font-size-3xl`). Tokens: `--tracking-h1`, `--tracking-h2`, `--tracking-eyebrow`, `--font-size-eyebrow`.

---

## Layout grid

- **Page max width**: 1440px (with 24px gutters at edges).
- **Side navigation**: 240px (deep-teal `.sidebar-shell`) → 64px icon-only when collapsed.
- **Top bar**: 64px, sticky, `.glass`.
- **Card padding**: 20–24px (16px on mobile).
- **Form vertical rhythm**: 16px between fields, 24px between sections.
- **Bento**: 4-column dense grid, 16px gap, `grid-auto-rows: minmax(120px, auto)`; 2 columns below 900px.

---

## Components (priority list for build order)

### 1. Layout primitives
- `<AppShell>` — top bar + side nav + main content
- `<PageHeader>` — title, breadcrumb, primary action
- `<Card>` — elevated surface with consistent padding
- `<Section>` — collapsible content group

### 2. Data display
- `<DataTable>` — TanStack Table-driven, with column visibility, sorting, filtering, server-side pagination
- `<StatusBadge>` — pill with color from status-color map
- `<RailBadge>` — small "NHCX" / "PMJAY" pill
- `<Timeline>` — case timeline showing all events
- `<KeyValueGrid>` — compact label/value display

### 3. Form primitives
- `<TextInput>`, `<TextArea>`, `<NumberInput>`, `<DateInput>`, `<DateRangeInput>`
- `<Select>`, `<MultiSelect>`, `<Combobox>` (with async search for ICD/HBP lookup)
- `<RadioGroup>`, `<CheckboxGroup>`
- `<FileUploader>` (multi-file, with progress, virus-scan-result indicator)
- `<FormSection>` (groups fields with a heading)
- All form fields integrate with React Hook Form + Zod resolvers

### 4. Modal system
- `<Modal>` — base dialog
- `<ConfirmModal>` — yes/no
- `<ErrorModal>` — bound to error code (see below)
- `<SuccessModal>`
- `<DocumentPreviewModal>` — inline PDF/image viewer
- `<AssistModal>` — PMJAY assist-mode side panel

### 5. Feedback
- `<Toast>` — non-blocking informational ("Document uploaded", etc.)
- `<EmptyState>` — illustrated empty list state
- `<LoadingShimmer>` — skeleton loaders
- `<ProgressBar>` — for multi-step submission

### 6. Domain-specific
- `<ClaimCard>` — summary card for a claim in a list
- `<DocumentChecklist>` — green/red checklist with per-item upload state
- `<PackageSelector>` — searchable HBP package picker with diagnosis-based suggestions
- `<EobViewer>` — side-by-side: PDF + LLM-extracted line items
- `<ClaimTimeline>` — vertical timeline of all events on a claim
- `<SlaBadge>` — on-track / at-risk / breached pill

---

## Modal-first error UX

**Rule**: every error that the user needs to understand or act on appears as a modal. No `alert()`, no unstyled toasts for serious errors, no silent failures.

### Modal anatomy

```
┌──────────────────────────────────────────┐
│ [Icon]  Modal title (one line, bold)     │   ← icon color = severity
│                                          │
│ One paragraph of plain-language          │   ← what happened, in user terms
│ explanation. No technical jargon.        │
│                                          │
│ Optional: details (collapsible).         │   ← error code, correlation ID, internal info for support
│                                          │
│         [Secondary]  [Primary CTA]       │   ← clear next step
└──────────────────────────────────────────┘
```

### Severity levels

| Severity | Icon  | Icon color   | Use case                                      |
|----------|-------|--------------|------------------------------------------------|
| Info     | ⓘ     | info-500     | Informational ("ABHA verified", "queued")      |
| Success  | ✓     | success-500  | Successful operation                           |
| Warning  | ⚠     | warning-500  | Degraded but operable                          |
| Error    | ✕     | danger-500   | Failed; user must take action                  |
| Critical | ⛔     | danger-700   | Hard block; admin or compliance issue          |

### Error → Modal mapping

Every error code in `reference/error-codes.md` maps to:

```ts
type ErrorModal = {
  code: string;            // e.g., 'NHCX_GATEWAY_UNAVAILABLE'
  severity: Severity;
  title: string;           // user-facing
  body: string;            // plain language explanation
  primaryAction?: {
    label: string;
    handler: () => void;
  };
  secondaryAction?: {
    label: string;
    handler: () => void;
  };
  showDetails: boolean;    // whether to show technical details collapsible
};
```

The frontend has a single `<ErrorBoundary>` + `useErrorModal()` hook:

```tsx
const { showError } = useErrorModal();

try {
  await api.preauth.submit(payload);
} catch (e) {
  if (isProblemDetails(e)) {
    showError(e.code, { context: { preauthId: payload.id } });
  } else {
    showError('UNEXPECTED_ERROR', { underlying: e });
  }
}
```

The hook reads from a static `ERROR_MAP` (generated from `reference/error-codes.md`) and renders the appropriate modal.

### Why modals, not toasts

For an insurance desk executive working through 30+ claims a day:
- A toast that disappears after 4 seconds is missed
- A toast that says "Pre-auth submission failed" without explaining why is useless
- A modal forces the user to acknowledge the issue and offers a clear next step

Toasts are reserved for **purely informational** events: "Document uploaded successfully", "Settings saved", "Payer master synced".

### Where modals should NOT appear

- Background polling failures that can be silently retried
- Loading states (use shimmer instead)
- Field validation errors (inline below the field is correct)
- Information already visible elsewhere (no need to redundantly modal)

---

## Form patterns

### Multi-step form pattern

For preauth, claim, etc. — each is multi-step:

```
[Step 1: Patient]  [Step 2: Policy]  [Step 3: Diagnosis]  [Step 4: Documents]  [Review]
                          ↑ active

(form content)

[Save Draft]                                                     [Back]  [Next →]
```

Auto-save every 10 seconds. Re-entry resumes at last step. Submission only happens on Review.

### Inline validation

Field-level errors appear inline with the field, in danger color, immediately below.

```
Diagnosis (ICD-10) *
[I25.10                ]     [Pick from list ↓]
✕ Code I25.10 has been deprecated since 2023; please use I25.110.
```

Form-level errors that affect submission (e.g., missing required documents) appear as a banner at the top of the form section, not as a modal — until the user actually clicks Submit, at which point a modal can appear.

### File uploads

- Drag-and-drop zone with click-to-browse fallback
- Preview thumbnails for images, icon for PDFs
- Per-file progress bars
- Virus-scan badge (Pending / Clean / Infected)
- Replace / delete inline

---

## Status display

Every claim list, every case detail, every analytics view shows status using:

```tsx
<StatusBadge status="PREAUTH_QUERY_RAISED" />
<RailBadge rail="nhcx" />
<SlaBadge state="AT_RISK" deadline={...} />
```

Status color mapping is in `apps/web/lib/claim/status-labels.ts`. See `docs/04-state-machines.md` for the full table.

---

## Empty states

Every list view has an empty state:

```
[Illustration]

Nothing here yet
You haven't created any cases for this filter.
[Create New Case]
```

Generic "no data" with no context = bad UX. Empty states are written per surface.

---

## Accessibility

- WCAG 2.1 AA target
- All interactive elements keyboard-navigable
- Focus rings (`--shadow-focus-primary` / `--shadow-focus-accent`)
- ARIA labels on icon-only buttons
- Form errors announced via `aria-live`
- Color is never the only signal (icons + text accompany state)
- Min target size 44×44 px on mobile

---

## Internationalization (planned, not v1)

Strings live in `apps/web/lib/i18n/`. V1 ships English only. Hindi planned for v1.5; Marathi/Tamil follow.

---

## Print styles

For exporting case summaries, claim packets:
- Hide nav, side panel, header
- Single-column flow
- Black-on-white tokens for ink saving
- Page break controls on `<Card>` elements

```css
@media print {
  .no-print { display: none; }
  .page-break { page-break-after: always; }
}
```

---

## Component library structure

```
apps/web/components/
├── ui/                    Design system primitives
│   ├── Button/
│   ├── Card/
│   ├── Input/
│   ├── Select/
│   ├── Modal/
│   ├── DataTable/
│   ├── StatusBadge/
│   ├── RailBadge/
│   └── ...
├── forms/                 Composed form patterns
│   ├── PreauthForm/
│   ├── ClaimForm/
│   ├── DocumentUploader/
│   └── ...
├── modals/                Per-error and per-flow modals
│   ├── ErrorModal/
│   ├── ConfirmModal/
│   ├── PmjayAssistModal/
│   └── error-map.ts       Maps error code → modal config
├── feedback/              Toast, EmptyState, Loading
├── layouts/               AppShell, PageHeader
├── data/                  Domain-specific composed views
│   ├── ClaimCard/
│   ├── ClaimTimeline/
│   ├── EobViewer/
│   ├── PackageSelector/
│   └── ...
└── icons/                 Wrapped lucide icons
```

---

## Storybook (recommended, not blocking v1)

Each `ui/` primitive has a Storybook story. Used for design review, regression spotting, accessibility checking. Worth setting up early; defer if v1 scope is tight.

---

## Tenant branding

Tenant config can override:
- Logo (replaces DigiSparsh logo on tenant-branded surfaces)
- Primary color (overrides `--color-primary-*` for that tenant)
- Accent color (overrides `--color-accent-*` for that tenant)

Implementation: `<TenantThemeProvider>` injects per-tenant CSS variables into `<html>`'s style attribute. Falls back to default tokens if no override.

The platform's own admin/operations surfaces always use the default DigiSparsh brand.
