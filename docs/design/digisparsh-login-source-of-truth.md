---
name: DigiSparsh Claims — Login-Anchored
colors:
  # ---- Brand ----
  # The login page hardcodes #008F99 as TEAL — this is the canonical
  # DigiSparsh brand teal. Every other surface must match. The earlier
  # token drift to #00666E is rejected; we are realigning back to login.
  primary: '#008F99'
  primary-container: '#0B7A82'
  on-primary: '#FFFFFF'
  on-primary-container: '#E8F6F7'
  primary-fixed: '#7FE5EC'
  primary-fixed-dim: '#5FCFDB'
  on-primary-fixed: '#002022'
  on-primary-fixed-variant: '#004F55'
  inverse-primary: '#7FE5EC'

  # ---- Accent (amber CTA) ----
  # Login uses amber for the primary CTA — gradient amber → amber-hover
  # with a teal-tinted ambient shadow. Reserved exclusively for "do
  # this now" actions.
  secondary: '#FAA719'
  secondary-container: '#E89510'
  on-secondary: '#FFFFFF'
  on-secondary-container: '#311A00'
  secondary-fixed: '#FFE0B5'
  secondary-fixed-dim: '#FFC36A'
  on-secondary-fixed: '#2A1800'
  on-secondary-fixed-variant: '#5C3A00'

  # ---- Text + outline ----
  # TEAL_DEEP, LABEL, MUTED on the login page — promoted to the
  # canonical text scale here.
  on-surface: '#0B2A2C'         # TEAL_DEEP from login
  on-surface-variant: '#3A5256' # LABEL from login
  on-background: '#0B2A2C'
  outline: '#6B8589'            # MUTED from login
  outline-variant: '#BCC9CA'
  inverse-surface: '#0B2A2C'
  inverse-on-surface: '#EDF4F5'

  # ---- Status ----
  tertiary: '#4FA88A'           # GREEN_CHECK from login
  on-tertiary: '#FFFFFF'
  tertiary-container: '#C8EBDA'
  on-tertiary-container: '#003B26'
  error: '#BA1A1A'
  on-error: '#FFFFFF'
  error-container: '#FFDAD6'
  on-error-container: '#93000A'

  # ---- Surface (background washes) ----
  # Login renders on rgba(255,255,255,0.72) glass over a warm off-white
  # base with subtle teal+amber ambient mesh wash. Reproduced here.
  background: '#F4F8FA'         # warm off-white
  surface: '#F4F8FA'
  surface-dim: '#D6DDDE'
  surface-bright: '#FBFEFE'
  surface-container-lowest: '#FFFFFF'
  surface-container-low: '#EEF4F5'
  surface-container: '#E8EFF0'
  surface-container-high: '#E2EAEB'
  surface-container-highest: '#DDE5E6'
  surface-tint: '#008F99'
  surface-variant: '#DFE3E4'

typography:
  # Login uses Sora exclusively. Inter remains the canonical body font
  # for dashboard surfaces (high-density data tables); Sora is the
  # premium voice for headings + auth + onboarding flows.
  h1:
    fontSize: 36px
    fontWeight: '700'
    lineHeight: '1.15'
    letterSpacing: -0.02em
  h2:
    fontSize: 28px
    fontWeight: '600'
    lineHeight: '1.3'
    letterSpacing: -0.015em
  h3:
    fontSize: 22px
    fontWeight: '600'
    lineHeight: '1.4'
    letterSpacing: -0.01em
  body:
    fontSize: 14.5px
    fontWeight: '400'
    lineHeight: '1.6'
  body-sm:
    fontSize: 13px
    fontWeight: '400'
    lineHeight: '1.5'
  eyebrow:
    # Login: 12px font-medium uppercase letter-spacing 0.04em.
    # We standardise eyebrows across the app to this single recipe.
    fontSize: 12px
    fontWeight: '500'
    textTransform: uppercase
    letterSpacing: 0.04em
  h1-mobile:
    fontSize: 28px
    fontWeight: '700'
    lineHeight: '1.2'
  bodyFont: 'Inter'
  headingFont: 'Sora'

rounded:
  sm: 0.375rem    # 6px — chips
  DEFAULT: 0.5rem # 8px — inputs (matches login 12px in inline style)
  md: 0.75rem     # 12px — input fields (login canonical)
  lg: 0.875rem    # 14px — CTAs (login canonical)
  xl: 1.75rem     # 28px — main glass cards (login canonical)
  full: 9999px    # pill — status badges, action chips

spacing:
  unit: 4px
  gutter: 24px
  margin-desktop: 40px
  margin-mobile: 16px
  container-max: 1440px
  card-padding: 44px  # login glass card uses 44px horizontal
---

## Brand & Style

The DigiSparsh Claims platform is a multi-tenant SaaS for Indian hospitals processing insurance claims via NHCX and PMJAY. The **login page is the canonical source of truth** for visual style — every other surface must visually descend from it. The aesthetic is **calm clinical glassmorphism** anchored by deep teal and balanced by amber for action urgency.

Visual narrative: **"Clarity through depth."** Frosted glass panels float over a warm off-white mesh wash with subtle teal and amber ambient glows. The result reads as sterile high-tech without feeling cold — a hospital admin console that calms rather than alarms.

The login card itself is the proof point: `rgba(255,255,255,0.72)` background, `backdrop-blur(28px) saturate(160%)`, 1px white hairline border, 28px corner radius, and an ambient teal shadow `0 40px 80px -24px rgba(0,80,86,0.32)`. Every other card on the platform inherits this recipe.

## Colors

**Primary Teal `#008F99`** — anchored at the login source-of-truth. Used for navigation, headings (`#0B2A2C` deep), icons, links, focus rings, brand surfaces. NOT used for primary CTAs — those are amber.

**Accent Amber `#FAA719` → `#E89510`** — strictly the primary call-to-action surface. Gradient top→bottom with an inset white highlight and a teal-tinted ambient shadow `0 12px 28px -8px rgba(250,167,25,0.5)`. One amber CTA per screen — multiple amber CTAs dilute the urgency signal.

**Background mesh:**
- Base `#F4F8FA` (warm off-white, NOT pure white — pure white would clash with the warm-teal glass)
- Teal radial glow at top-left, 25% opacity
- Amber radial glow at top-right, 10% opacity (much fainter than teal — amber is meant to be rare)

**Text scale (from login):**
- Headings: `#0B2A2C` (TEAL_DEEP)
- Body: `#0B2A2C` (same — high contrast on glass)
- Labels / eyebrows: `#3A5256` (LABEL)
- Secondary text: `#6B8589` (MUTED)

**Sidebar** uses a solid deep-teal gradient `#0d7a82 → #075c63`. This is the one surface that breaks glass — it's a structural anchor and needs to feel grounded, not floating.

## Typography

**Two fonts.** Sora for premium voice (auth, marketing surfaces, headings on landing-style pages); Inter for the high-density operator console (cases list, tables, forms). Both already loaded via `globals.css`.

- **H1 (36px, font-weight 700, tracking -0.02em)** — only on auth + landing.
- **H2 (28px, font-semibold, tracking -0.015em)** — page-level headings on operator screens. Match the "Welcome back" of login.
- **H3 (22px, font-semibold)** — section headings inside cards.
- **Body (14.5px)** — the login default. Use everywhere except dense data tables.
- **Eyebrow (12px uppercase, tracking 0.04em)** — the single most consistent recipe on the platform. Every form label, every section meta-line, every status pill text uses it.
- **Tabular numerics** — money, percentages, dates, MRNs all use `tabular-nums` so rows align cleanly in vertical scans.

## Layout & Bento

Operator surfaces use a **4-column bento grid** at desktop (1200px+) with 24px gutters. Cards span 1, 2, or 4 columns based on priority. The hero tile (welcome / status / primary CTA) spans 2×2 in a `from-primary to-primary-container` gradient. KPI tiles are 1×1 glass cards. Drill-down tables fill the bottom 4 columns.

Tablet (768–1199px) reflows to 2 columns. Mobile (<768px) stacks single-column with 16px margins.

The 4px base spacing scale (4, 8, 12, 16, 20, 24, 32, 40, 48, 64) governs every gap — no arbitrary spacing.

## Elevation & Glass

Three levels:

1. **Level 0 (canvas):** The warm off-white mesh wash. No card.
2. **Level 1 (cards):** `.glass` recipe — `rgba(255,255,255,0.72)` + `backdrop-blur(28px) saturate(160%)` + 1px `rgba(255,255,255,0.9)` hairline border + 28px corner radius + ambient teal shadow `0 40px 80px -24px rgba(0,80,86,0.32)` + secondary tighter shadow + inset white highlight. Used on every panel.
3. **Level 2 (modals / overlays):** `.glass-strong` — opacity bumps to 0.85, blur to 40px, shadow opacity to 0.45, plus a focus-trap backdrop.

**Shadows are always teal-tinted, never pure black.** `rgba(0,80,86,...)` at low opacity. Black shadows on glass look cheap.

## Shape language

- **Cards** — 28px radius. The login card is the canonical reference; copy its proportions verbatim on any large content panel.
- **Inputs** — 12px radius. Tighter than cards so they read as "inside the card."
- **CTAs (amber)** — 14px radius. Slightly tighter than cards so they read as action elements, not surfaces.
- **Status pills + chips** — full pill (9999px). Pills tell the user "this is a tag, not a button."
- **Icons** — Material Symbols Outlined at 400 weight by default; 500 weight when filled (active states).

## Motion

Subtle, never decorative:
- Hover lift on glass cards: `translateY(-1px)` + shadow bump. 180ms ease-out.
- CTA press: `scale(0.99)`. 120ms.
- Focus ring on inputs: 220ms ease. Color transitions from outline-variant → primary.
- Loading shimmer: 1.4s sweep, paused for `prefers-reduced-motion`.

No flashy hero animations, no parallax. This is an operator console — speed is the feature.

## Voice in copy

Sentence case for everything except eyebrow labels (which are uppercase). Be direct: "Verify coverage" not "Click here to verify coverage." Numbers always render with the rupee symbol (₹) prefix and `tabular-nums`. Dates in `en-IN` locale. Status verbs in present perfect ("Verified", "Submitted", "Approved").

## Components inventory

The platform already ships the design system in `apps/web/components/`. The Stitch redesign should preserve these primitive shapes and re-skin them, not replace them:

- **DashboardChrome** (sidebar + topbar + main)
- **glass / glass-strong / glass-tint / glass-card** CSS recipes
- **LoadingShimmer** (`variant: 'page' | 'row'`)
- **PreflightStat** tile (mini KPI inside the new-case Verify-coverage card)
- **SlaPill** (status badge)
- **AssigneeWidget**
- **ErrorModal** + **ToastProvider** (toasts FIFO, max 4 visible)
- **useConfirm / usePrompt** (modal-promise helpers)

## Screens priority

For Stitch generation, in this order:

1. **`/dashboard`** — bento grid: hero tile + 4 KPI tiles + Quick Actions row.
2. **`/cases/[id]`** — case detail with header + 6 operator panels (preauth → enhancement → discharge → claim → settlement → comms).
3. **`/cases`** — list with search + filter pills + cards/rows density toggle.
4. **`/cases/new`** — eligibility-first preflight (Verify coverage → auto-fill room limit → admission → consent).
5. **`/admin/variance`** — CFO variance dashboard with KPI tiles + aging buckets + drill-down.

Everything else inherits from these five.
